const logError = (context, error) => {
  const message = error?.message || String(error);
  const stack = error?.stack;

  console.error(`[ERROR] ${context} - ${message}`);
  if (stack) console.error(stack);
};

module.exports = {
  logError,
};

