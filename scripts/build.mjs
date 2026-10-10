import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('public', { recursive: true });
await copyFile('index.html', 'public/index.html');
console.log('HTML preparado. A Vercel publica a função de api/poll.js separadamente.');
