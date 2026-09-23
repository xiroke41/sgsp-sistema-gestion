import bcrypt from 'bcryptjs';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const prompt = readline.createInterface({ input, output });
try {
  let password = '';
  while (password.length < 8) {
    password = await prompt.question('Contrasena (minimo 8 caracteres): ');
    if (password.length < 8) console.error('La contrasena debe tener al menos 8 caracteres. Intenta nuevamente.');
  }
  console.log(await bcrypt.hash(password, 12));
} finally {
  prompt.close();
}
