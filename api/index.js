// Vercel serverless entry point: runs migrations once per cold start,
// then hands the request to the Express app.

require("dotenv").config();

const app = require("../src/app");
const { migrate } = require("../src/db");

let ready;
function ensureMigrated() {
  ready ??= migrate().catch((e) => {
    ready = undefined; // retry on the next request if the first fails
    throw e;
  });
  return ready;
}

module.exports = async (req, res) => {
  await ensureMigrated();
  app(req, res);
};
