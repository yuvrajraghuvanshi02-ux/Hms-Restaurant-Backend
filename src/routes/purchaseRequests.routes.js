const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { attachTenantDb } = require("../middleware/tenant");
const { requireTenantAdmin } = require("../middleware/requireTenantAdmin");
const { checkPermission } = require("../middleware/permissions");
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

router.post("/", checkPermission("purchases", "add"), createPurchaseRequest);
router.get("/", checkPermission("purchases", "view"), listPurchaseRequests);
router.get("/approval", checkPermission("purchases", "view"), listPendingPurchaseRequestsForApproval);
router.get("/:id", checkPermission("purchases", "view"), getPurchaseRequest);
router.put("/:id/status", checkPermission("purchases", "edit"), updatePurchaseRequestStatus);
router.put("/:id/approve", checkPermission("purchases", "edit"), approvePurchaseRequest);
router.put("/:id/reject", checkPermission("purchases", "edit"), rejectPurchaseRequest);

module.exports = router;

