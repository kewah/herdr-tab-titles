module.exports = function assertTitleFormat(output) {
  const title = String(output ?? "");
  const words = title.split(/\s+/);
  const failures = [];

  if (title !== title.trim() || /[\r\n]/.test(title)) failures.push("must be one trimmed line");
  if (title.length > 40) failures.push("must be at most 40 characters");
  if (words.length < 2 || words.length > 5) failures.push("must contain 2-5 words");
  if (/^(?:[-*+]\s+|\d+[.)]\s+)/.test(title)) failures.push("must not start with a list marker");
  if (/^#{1,6}\s+|```|[*_~]{2}/.test(title)) failures.push("must not contain Markdown");
  if (/[.,:;!?]$/.test(title)) failures.push("must not end with punctuation");

  return {
    pass: failures.length === 0,
    score: failures.length === 0 ? 1 : 0,
    reason: failures.length === 0 ? "Title follows the required format" : failures.join("; "),
  };
};
