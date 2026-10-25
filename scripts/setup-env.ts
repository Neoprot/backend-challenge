import { constants, copyFile } from 'node:fs/promises';

// COPYFILE_EXCL impede sobrescrever configurações locais existentes.
try {
  await copyFile(new URL('../.env.example', import.meta.url), new URL('../.env', import.meta.url), constants.COPYFILE_EXCL);
  console.log('.env criado a partir de .env.example.');
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  console.log('.env existente preservado.');
}
