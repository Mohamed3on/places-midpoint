import fs from 'fs';

export const readFromDisk = (path: string) => {
  const data = fs.readFileSync(path, { encoding: 'utf8' });
  return JSON.parse(data);
};
