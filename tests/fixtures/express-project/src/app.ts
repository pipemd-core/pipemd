import express from 'express';
import usersRouter from './routes/users';
import productsRouter from './routes/products';

const app = express();

app.use(express.json());

app.use('/api', usersRouter);
app.use('/api', productsRouter);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

export default app;