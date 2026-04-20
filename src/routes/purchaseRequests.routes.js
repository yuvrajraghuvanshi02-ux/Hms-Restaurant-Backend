const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { attachTenantDb } = require("../middleware/tenant");
const { requireTenantAdmin } = require("../middleware/requireTenantAdmin");
const {
  createPurchaseRequest,
  listPurchaseRequests,
  listPendingPurchaseRequestsForApproval,
  getPurchaseRequest,
  updatePurchaseRequestStatus,
  approvePurchaseRequest,
  rejectPurchaseRequest,
} = require("../controllers/purchaseRequests.controller");

const router = express.Router();

router.use(requireAuth, attachTenantDb, requireTenantAdmin);

router.post("/", createPurchaseRequest);
router.get("/", listPurchaseRequests);
router.get("/approval", listPendingPurchaseRequestsForApproval);
router.get("/:id", getPurchaseRequest);
router.put("/:id/status", updatePurchaseRequestStatus);
router.put("/:id/approve", approvePurchaseRequest);
router.put("/:id/reject", rejectPurchaseRequest);

module.exports = router;

