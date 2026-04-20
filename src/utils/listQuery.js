const clampInt = (value, { fallback, min, max }) => {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(Math.max(n, min), max);
};

const parseListParams = (query, { defaultSortBy = "created_at", defaultOrder = "DESC" } = {}) => {
  const page = clampInt(query?.page, { fallback: 1, min: 1, max: 1000000 });
  const limit = clampInt(query?.limit, { fallback: 10, min: 1, max: 100 });
  const offset = (page - 1) * limit;
  const search = String(query?.search || "").trim();

  const sortBy = String(query?.sortBy || defaultSortBy).trim();
  const orderRaw = String(query?.order || defaultOrder).trim().toUpperCase();
  const order = orderRaw === "ASC" ? "ASC" : "DESC";

  return { page, limit, offset, search, sortBy, order };
};

const buildPagination = ({ total, page, limit }) => {
  const totalNum = Number(total) || 0;
  const totalPages = Math.max(1, Math.ceil(totalNum / limit));
  return { total: totalNum, page, limit, totalPages };
};

const pickSort = ({ sortBy, order }, whitelist, fallback) => {
  const col = whitelist.includes(sortBy) ? sortBy : fallback;
  return { sortBy: col, order };
};

module.exports = {
  parseListParams,
  buildPagination,
  pickSort,
};

