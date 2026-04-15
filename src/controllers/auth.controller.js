const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { pool } = require("../config/db");

const normalizeEmail = (email) => String(email || "").trim().toLowerCase();

const login = async (req, res) => {
  const { email, password, role } = req.body;

  if (!email || !password || !role) {
    return res
      .status(400)
      .json({ message: "Email, password, and role are required." });
  }

  try {
    const emailNormalized = normalizeEmail(email);

    if (role === "staff") {
      return res.status(501).json({ message: "Not implemented yet." });
    }

    if (role === "super_admin") {
      const query = `
        SELECT id, email, password, role, status
        FROM super_admin_users
        WHERE email = $1
        LIMIT 1
      `;
      const result = await pool.query(query, [emailNormalized]);

      if (result.rowCount === 0) {
        return res.status(401).json({ message: "Invalid credentials." });
      }

      const user = result.rows[0];
      if (user.status !== "active") {
        return res.status(403).json({ message: "User is inactive." });
      }

      const isPasswordValid = await bcrypt.compare(password, user.password);
      if (!isPasswordValid) {
        return res.status(401).json({ message: "Invalid credentials." });
      }

      const token = jwt.sign(
        {
          user_id: user.id,
          role: "super_admin",
        },
        process.env.JWT_SECRET,
        { expiresIn: "12h" }
      );

      return res.status(200).json({
        message: "Login successful.",
        token,
        user: {
          id: user.id,
          email: user.email,
          role: "super_admin",
        },
      });
    }

    if (role === "admin") {
      const query = `
        SELECT id, restaurant_id, email, password, role
        FROM restaurant_admins
        WHERE email = $1
        LIMIT 1
      `;
      const result = await pool.query(query, [emailNormalized]);

      if (result.rowCount === 0) {
        return res.status(401).json({ message: "Invalid credentials." });
      }

      const user = result.rows[0];
      const isPasswordValid = await bcrypt.compare(password, user.password);
      if (!isPasswordValid) {
        return res.status(401).json({ message: "Invalid credentials." });
      }

      const token = jwt.sign(
        {
          user_id: user.id,
          restaurant_id: user.restaurant_id,
          role: "admin",
        },
        process.env.JWT_SECRET,
        { expiresIn: "12h" }
      );

      return res.status(200).json({
        message: "Login successful.",
        token,
        user: {
          id: user.id,
          email: user.email,
          role: "admin",
          restaurant_id: user.restaurant_id,
        },
      });
    }

    return res.status(400).json({ message: "Invalid role." });
  } catch (error) {
    console.error("Login error:", error.message);
    return res.status(500).json({ message: "Internal server error." });
  }
};

module.exports = {
  login,
};
