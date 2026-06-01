module.exports = async function echoWorker({ value, delayMs = 0 }) {
  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return value;
};
