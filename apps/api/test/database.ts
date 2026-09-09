/** Test suites truncate tables. Refuse any database not explicitly named as a test database. */
export function testDatabaseUrl():string {
 const value=process.env.TEST_DATABASE_URL??'postgresql://localhost:5432/silverline_test';
 const name=decodeURIComponent(new URL(value).pathname.slice(1));
 if(!/(^test_|_test$)/.test(name))throw new Error('TEST_DATABASE_URL must point to a dedicated database named test_* or *_test');
 return value;
}
