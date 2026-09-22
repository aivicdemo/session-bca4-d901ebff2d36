/** @type {import('jest').Config} */
module.exports = {
  testMatch: ["**/tests/unit/**/*.test.ts", "**/tests/unit/**/*.test.js"],
  transform: { "^.+\\.tsx?$": "ts-jest" },
  testEnvironment: "node",
};
