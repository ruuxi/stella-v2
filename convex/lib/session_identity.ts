export const sessionIdentityMatchesExpectedSubject = (
  identitySubject: string,
  expectedSubject: string,
): boolean => {
  const expected = expectedSubject.trim();
  return expected.length > 0 && identitySubject === expected;
};
