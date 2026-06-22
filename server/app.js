import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { authRouter } from './routes/auth.js';

const app = express();

app.use(helmet());
app.use(cors({ origin: true }));
app.use(express.json());

app.use(
  rateLimit({
    windowMs: config.rateLimit.windowMs,
    max: config.rateLimit.maxRequests,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

app.use('/api/auth', authRouter);

app.get('/', (req, res) => {
  res.json({
    name: 'ActiveDev API',
    version: '1.0.0',
    auth_endpoints: {
      start: '/api/auth/start',
      callback: '/api/auth/callback',
    },
  });
});

export default app;
