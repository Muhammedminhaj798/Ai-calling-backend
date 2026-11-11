import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createExotelTelephony } from './exotel.adapter.ts';

const adapter = createExotelTelephony({ webhookSecret: 'secret-token-0123456789', allowedIps: ['1.2.3.4'] });

describe('Exotel adapter', () => {
  it('verifies the URL secret and the source IP', () => {
    assert.equal(adapter.verifyWebhook({ ip: '1.2.3.4', secret: 'secret-token-0123456789', headers: {} }), true);
    assert.equal(adapter.verifyWebhook({ ip: '::ffff:1.2.3.4', secret: 'secret-token-0123456789', headers: {} }), true);
    assert.equal(adapter.verifyWebhook({ ip: '9.9.9.9', secret: 'secret-token-0123456789', headers: {} }), false);
    assert.equal(adapter.verifyWebhook({ ip: '1.2.3.4', secret: 'wrong', headers: {} }), false);
    assert.equal(adapter.verifyWebhook({ ip: '1.2.3.4', secret: undefined, headers: {} }), false);
    const open = createExotelTelephony({ webhookSecret: 'secret-token-0123456789', allowedIps: [] });
    assert.equal(open.verifyWebhook({ ip: '9.9.9.9', secret: 'secret-token-0123456789', headers: {} }), true);
  });

  it('parses incoming and status webhooks and normalises phone numbers', () => {
    const incoming = adapter.parseIncoming({ CallSid: 'abc123', From: '09847012345', To: '04842345678', Direction: 'incoming' });
    assert.deepEqual({ sid: incoming.providerCallSid, from: incoming.fromNumber, to: incoming.toNumber }, { sid: 'abc123', from: '+919847012345', to: '+914842345678' });
    const status = adapter.parseStatus({ CallSid: 'abc123', Status: 'completed', ConversationDuration: '95', RecordingUrl: 'https://example.invalid/rec.mp3' });
    assert.deepEqual({ sid: status.providerCallSid, status: status.status, duration: status.durationSeconds, rec: status.recordingUrl }, { sid: 'abc123', status: 'completed', duration: 95, rec: 'https://example.invalid/rec.mp3' });
    assert.throws(() => adapter.parseIncoming({ From: '1' }));
  });

  it('parses Voicebot media-stream messages', () => {
    const start = adapter.parseMediaMessage(JSON.stringify({ event: 'start', stream_sid: 'ST1', start: { call_sid: 'abc123', from: '9847012345', to: '04842345678', media_format: { encoding: 'raw', sample_rate: '8000' }, custom_parameters: { lang: 'ml' } } }));
    assert.equal(start.event, 'start');
    if (start.event === 'start') {
      assert.equal(start.streamSid, 'ST1');
      assert.equal(start.callSid, 'abc123');
      assert.equal(start.fromNumber, '+919847012345');
      assert.equal(start.sampleRate, 8000);
      assert.deepEqual(start.custom, { lang: 'ml' });
    }
    const media = adapter.parseMediaMessage(JSON.stringify({ event: 'media', stream_sid: 'ST1', media: { chunk: 1, timestamp: '20', payload: Buffer.alloc(320).toString('base64') } }));
    assert.equal(media.event, 'media');
    if (media.event === 'media') assert.equal(media.audio.length, 320);
    assert.deepEqual(adapter.parseMediaMessage(JSON.stringify({ event: 'stop', stop: { reason: 'callended' } })), { event: 'stop', reason: 'callended' });
    assert.deepEqual(adapter.parseMediaMessage(JSON.stringify({ event: 'dtmf', dtmf: { digit: '5' } })), { event: 'dtmf', digit: '5' });
    assert.equal(adapter.parseMediaMessage('not json').event, 'unknown');
  });

  it('builds outbound frames of at least 3.2 KB, each a multiple of 320 bytes', () => {
    const pcm = Buffer.alloc(3200 * 2 + 1000, 1);
    const frames = adapter.buildMediaFrames('ST1', pcm);
    assert.equal(frames.length, 3);
    for (const f of frames) {
      const msg = JSON.parse(f) as { event: string; stream_sid: string; media: { payload: string } };
      assert.equal(msg.event, 'media');
      assert.equal(msg.stream_sid, 'ST1');
      const bytes = Buffer.from(msg.media.payload, 'base64').length;
      assert.ok(bytes >= 3200, `frame ${bytes} bytes`);
      assert.equal(bytes % 320, 0);
    }
    assert.deepEqual(JSON.parse(adapter.buildClear('ST1')), { event: 'clear', stream_sid: 'ST1' });
    assert.deepEqual(JSON.parse(adapter.buildMark('ST1', 'end')), { event: 'mark', stream_sid: 'ST1', mark: { name: 'end' } });
  });

  it('refuses to pretend a transfer happened', async () => {
    await assert.rejects(adapter.transferToStaff('abc123', '+919000000000'), /not configured/);
  });
});
