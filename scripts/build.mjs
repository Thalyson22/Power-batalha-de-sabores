import { mkdir, copyFile, cp } from 'node:fs/promises';
await mkdir('public', { recursive: true });
await copyFile('index.html', 'public/index.html');
await cp('assets', 'public/assets', { recursive: true });
console.log('HTML, fotos e fontes preparados. A Vercel publica a função de api/poll.js separadamente.');
