import express from 'express';
import { PrismaClient } from '@prisma/client';
import morgan from 'morgan';

import authRouter from './routes/auth';
import usersRouter from './routes/users';
import qrRouter from './routes/qr';
import passwordResetRouter from './routes/passwordReset';
import cors from 'cors';
import { errorHandler } from './middleware/errorHandler';

const app = express();
app.use(cors({
  origin: ['http://localhost:8081', 'http://192.168.30.54:8081', '*'],
  credentials: true,
}));

const databaseUrl = process.env.NODE_ENV === 'development' ? process.env.DATABASE_URL_DEV : process.env.DATABASE_URL;
const prisma = new PrismaClient({
  datasources: {
    db: {
      url: databaseUrl,
    },
  },
});

const port = process.env.PORT || 3000;

app.use(morgan('dev'));
app.use(express.json());

app.use('/auth', authRouter);
app.use('/users', usersRouter);
app.use('/qr', qrRouter);
app.use('/password-reset', passwordResetRouter);

// Подключаем обработчик ошибок
app.use(errorHandler);
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
