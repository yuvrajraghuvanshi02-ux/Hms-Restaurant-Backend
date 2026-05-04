const express = require("express");
const cors = require("cors");
const path = require("path");
const authRoutes = require("./routes/auth.routes");
const restaurantRoutes = require("./routes/restaurant.routes");
const inventoryRoutes = require("./routes/inventory.routes");
const mastersRoutes = require("./routes/masters.routes");
const menuRoutes = require("./routes/menu.routes");
const uploadsRoutes = require("./routes/uploads.routes");
const recipesRoutes = require("./routes/recipes.routes");
const stockRoutes = require("./routes/stock.routes");
const suppliersRoutes = require("./routes/suppliers.routes");
const purchaseRequestsRoutes = require("./routes/purchaseRequests.routes");
const purchaseOrdersRoutes = require("./routes/purchaseOrders.routes");
const grnsRoutes = require("./routes/grns.routes");
const tableTypesRoutes = require("./routes/tableTypes.routes");
const tablesRoutes = require("./routes/tables.routes");
const ordersRoutes = require("./routes/orders.routes");
const kitchenRoutes = require("./routes/kitchen.routes");
const paymentsRoutes = require("./routes/payments.routes");
const reportsRoutes = require("./routes/reports.routes");
const dashboardRoutes = require("./routes/dashboard.routes");
const taxesRoutes = require("./routes/taxes.routes");
const auditRoutes = require("./routes/audit.routes");
const publicRoutes = require("./routes/public.routes");
const staffRoutes = require("./routes/staff.routes");
const errorHandler = require("./middleware/errorHandler");

const app = express();

app.use(cors());
app.use(express.json());
app.use("/uploads", express.static(path.join(__dirname, "..", "uploads")));

app.get("/api/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    message: "Restaurant backend is running.",
  });
});

app.use("/api/auth", authRoutes);
app.use("/api/restaurants", restaurantRoutes);
app.use("/api/inventory", inventoryRoutes);
app.use("/api/masters", mastersRoutes);
app.use("/api/menu", menuRoutes);
app.use("/api/uploads", uploadsRoutes);
app.use("/api/recipes", recipesRoutes);
app.use("/api/stock", stockRoutes);
app.use("/api/suppliers", suppliersRoutes);
app.use("/api/purchase-requests", purchaseRequestsRoutes);
app.use("/api/purchase-orders", purchaseOrdersRoutes);
app.use("/api/grns", grnsRoutes);
app.use("/api/table-types", tableTypesRoutes);
app.use("/api/tables", tablesRoutes);
app.use("/api/orders", ordersRoutes);
app.use("/api/kitchen", kitchenRoutes);
app.use("/api/payments", paymentsRoutes);
app.use("/api/reports", reportsRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/taxes", taxesRoutes);
app.use("/api/audit", auditRoutes);
app.use("/api/public", publicRoutes);
app.use("/api/staff", staffRoutes);
app.use(errorHandler);

module.exports = app;
