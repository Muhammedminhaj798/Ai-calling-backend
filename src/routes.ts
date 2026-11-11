// All feature routers under one prefix. Mounted at /api by app.ts.
import { Router } from 'express';
import { approvalsRouter } from './modules/approvals/approvals.routes.ts';
import { authRouter } from './modules/auth/auth.routes.ts';
import { callsRouter, conversationsRouter } from './modules/calls/calls.routes.ts';
import { customersRouter } from './modules/customers/customers.routes.ts';
import { exceptionsRouter } from './modules/exceptions/exceptions.routes.ts';
import { inventoryRouter } from './modules/inventory/inventory.routes.ts';
import { ordersRouter } from './modules/orders/orders.routes.ts';
import { productsRouter } from './modules/products/products.routes.ts';
import { settingsRouter, staffRouter } from './modules/settings/settings.routes.ts';

export const apiRouter = Router();
apiRouter.use('/auth', authRouter);
apiRouter.use('/customers', customersRouter);
apiRouter.use('/products', productsRouter);
apiRouter.use('/inventory', inventoryRouter);
apiRouter.use('/orders', ordersRouter);
apiRouter.use('/approvals', approvalsRouter);
apiRouter.use('/exceptions', exceptionsRouter);
apiRouter.use('/calls', callsRouter);
apiRouter.use('/conversations', conversationsRouter);
apiRouter.use('/settings', settingsRouter);
apiRouter.use('/staff', staffRouter);
