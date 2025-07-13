import express from 'express';
import { PrismaClient } from '@prisma/client';

const app = express();

const databaseUrl = process.env.NODE_ENV === 'development' ? process.env.DATABASE_URL_DEV : process.env.DATABASE_URL;
const prisma = new PrismaClient({
  datasources: {
    db: {
      url: databaseUrl,
    },
  },
});

const port = process.env.PORT || 3000;

app.use(express.json());

import authRouter from './routes/auth';

app.use('/', authRouter);

app.get('/', async (req, res) => {
  try {
    // Simple test query to check DB connection
    const result = await prisma.$queryRaw`SELECT 1+1 AS result`;
    res.json({ message: 'Server is running', dbTest: result });
  } catch (error) {
    res.status(500).json({ error: 'Database connection failed', details: error });
  }
});

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});

export default app;
