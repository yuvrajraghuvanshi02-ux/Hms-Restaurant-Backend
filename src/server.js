require("dotenv").config();
const app = require("./app");
const { testDbConnection } = require("./config/db");
const { ensureMasterSchema } = require("./migrations/master/initMasterSchema");

const PORT = Number(process.env.PORT) || 5000;

const startServer = async () => {
  try {
    await testDbConnection();
    await ensureMasterSchema();
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Server startup failed:", error.message);
    process.exit(1);
  }
};

startServer();
