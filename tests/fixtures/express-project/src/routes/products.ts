import { Router, Request, Response } from 'express';

const router = Router();

router.get('/products', (_req: Request, res: Response) => {
  res.json([{ id: 1, name: 'Widget' }]);
});

router.get('/products/:id', (req: Request, res: Response) => {
  res.json({ id: Number(req.params.id), name: 'Widget' });
});

router.post('/products', (req: Request, res: Response) => {
  res.status(201).json({ id: 2, ...req.body });
});

router.patch('/products/:id', (req: Request, res: Response) => {
  res.json({ id: Number(req.params.id), ...req.body });
});

export default router;