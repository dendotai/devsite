// Release versions as semantic-release writes them: major.minor.patch.
const parts = (v: string) => v.split(/[.-]/, 3).map((n) => Number.parseInt(n, 10) || 0);

export function isOlder(a: string, b: string): boolean {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0;
  }
  return false;
}
