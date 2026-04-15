const express = require("express");
const multer = require("multer");
const {
  createRestaurant,
  getRestaurantById,
  listRestaurants,
  updateRestaurant,
} = require("../controllers/restaurant.controller");
const { requireSuperAdmin } = require("../middleware/auth");

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, callback) => {
    const acceptedTypes = ["image/png", "image/jpeg", "image/jpg", "image/webp"];
    if (!acceptedTypes.includes(file.mimetype)) {
      callback(new Error("Only PNG, JPG, JPEG, and WEBP files are allowed."));
      return;
    }
    callback(null, true);
  },
});

router.post("/create", requireSuperAdmin, upload.single("logo"), createRestaurant);
router.get("/", requireSuperAdmin, listRestaurants);
router.get("/:id", requireSuperAdmin, getRestaurantById);
router.put("/:id", requireSuperAdmin, updateRestaurant);

module.exports = router;

