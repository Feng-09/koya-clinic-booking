require("dotenv").config();
const app = require("./app");
const { migrate } = require("./db");

const port = process.env.PORT || 3000;

migrate()
  .then(() => {
    app.listen(port, () => console.log(`Clinic booking API listening on :${port}`));
  })
  .catch((e) => {
    console.error("Failed to start:", e);
    process.exit(1);
  });
