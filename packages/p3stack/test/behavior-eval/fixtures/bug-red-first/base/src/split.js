// Splits a bill of `total` cents into `people` shares.
export function splitCents(total, people) {
  const share = Math.floor(total / people);
  return Array.from({ length: people }, () => share);
}
