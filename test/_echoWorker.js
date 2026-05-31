module.exports = async function echoWorker({ value, delayMs }) {
  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return value;
};
