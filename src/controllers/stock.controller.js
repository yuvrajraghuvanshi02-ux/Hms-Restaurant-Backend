const { logError } = require("../utils/logError");
const { addStock, deductStockByVariant } = require("../services/stock.service");

const addStockHandler = async (req, res) => {
  try {
    await addStock(req.tenantDB, req.body || {});
    return res.status(200).json({ message: "Stock updated successfully" });
  } catch (error) {
    if (error?.statusCode) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    logError("POST /api/stock/add", error);
    return res.status(500).json({ message: "Failed to update stock." });
  }
};

const testDeductHandler = async (req, res) => {
  try {
    const variantId = req.body?.menu_item_variant_id;
    await deductStockByVariant(req.tenantDB, variantId);
    return res.status(200).json({ message: "Stock updated successfully" });
  } catch (error) {
    if (error?.statusCode) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    logError("POST /api/stock/test-deduct", error);
    return res.status(500).json({ message: "Failed to deduct stock." });
  }
};

module.exports = {
  addStockHandler,
  testDeductHandler,
};

