/** @type {import("@changesets/types").ChangelogFunctions} */
export default {
  // We're not using dependency updates:
  getDependencyReleaseLine: () => Promise.resolve(""),

  // The `changesets` array contains all of the summaries (minor + patch)
  getReleaseLine: async ({ summary }) => `- ${summary}`,
};
