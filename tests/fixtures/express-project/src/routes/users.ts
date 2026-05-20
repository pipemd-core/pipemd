import { Router, Request, Response } from 'express';

const router = Router();

router.get('/users', (_req: Request, res: Response) => {
  res.json([{ id: 1, name: 'Alice' }]);
});

router.get('/users/:id', (req: Request, res: Response) => {
  res.json({ id: Number(req.params.id), name: 'Alice' });
});

router.post('/users', (req: Request, res: Response) => {
  res.status(201).json({ id: 2, ...req.body });
});

router.put('/users/:id', (req: Request, res: Response) => {
  res.json({ id: Number(req.params.id), ...req.body });
});

router.delete('/users/:id', (_req: Request, res: Response) => {
  res.status(204).send();
});

export default router;