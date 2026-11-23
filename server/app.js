import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { authRouter } from './routes/auth.js';

const app = express();

// Vercel (and most hosts) sit behind one proxy; needed for per-client rate limiting.
app.set('trust proxy', 1);

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
      app: '/api/auth/app',
    },
  });
});

export default app;
