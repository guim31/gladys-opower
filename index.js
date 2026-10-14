// -----------------------------------------------------------------------------
// Entry point of the Opower integration: SDK wiring only.
//
// The work lives in src/app.js (one cycle reads the utility and feeds Gladys)
// and the modules it uses. This file instantiates the SDK, registers the
// handlers BEFORE connect(), and connects.
//
// The Gladys supervisor provides GLADYS_HOST_API_URL, GLADYS_INTEGRATION_TOKEN
// and GLADYS_INTEGRATION_SELECTOR (read by the SDK), and TZ, the Gladys time
// zone (the day a daily consumption is stamped on).
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { createApp, registerHandlers } from './src/app.js';
import { createFileStore } from './src/store.js';

const gladys = new GladysIntegration();
const app = createApp({ gladys, store: createFileStore() });

registerHandlers(gladys, app);

gladys.handleShutdown(() => {
  app.stop();
});

gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
