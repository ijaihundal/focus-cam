// Generate a bcrypt hash for your password.
// Usage:  node hash.js "your-password"
const bcrypt = require("bcryptjs");

const password = process.argv[2];
if (!password) {
  console.error('Usage: node hash.js "your-password"');
  process.exit(1);
}
const hash = bcrypt.hashSync(password, 10);
console.log("\nPut this in your .env as AUTH_PASSWORD_HASH:\n");
console.log(hash);
console.log("");
