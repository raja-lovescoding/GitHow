import { createApp } from './app.js';
const app = createApp();
app.listen({ port: Number(process.env.API_PORT ?? 4000), host: '0.0.0.0' }).catch((error) => { app.log.error(error); process.exit(1); });
