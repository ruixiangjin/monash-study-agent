## Commit Message Guidelines

**Some important guidelines to write meaningful GIT commit messages:**

- **Separate subject from body:**
  - Keep the subject line concise (50 characters or less).
  - Use a blank line between the subject and the body.
- **Use the imperative mood:**
  - Start the subject line with a verb in the imperative mood (e.g., "Add feature," "Fix bug," "Update documentation").
- **Provide context in the body:**
  - Explain why the change is necessary and how it addresses the issue.
  - You can add details as a dot-list (see good examples below).
  - Use the body to provide additional details, but avoid duplicating information already in the subject.
- **Limit the subject line to one sentence:**
  - Capture the essence of the commit in a single line to make it easily scannable.
- **Be consistent with formatting:**
  - Choose a consistent style for your commit messages and stick to it across the project.

**Good Commit Message Examples:**

- Update README with installation instructions - Clarifies the steps needed to install the application - Adds troubleshooting tips for common issues
- Refactor database connection handling - Improves efficiency and error handling in database connections - Enhances code readability
- Fix navbar responsiveness issue - Adjusts CSS to ensure proper responsiveness on various screen sizes - Resolves #87
- Implement email notification system - Adds functionality to send email notifications on user events - Introduces new configuration options in settings
- Remove deprecated API endpoints - Cleans up unused and deprecated API endpoints - Updates documentation accordingly

**Bad Commit Message Examples:**

- Updated files - Modified various files - Some changes for better performance
- Big changes - Made significant changes to the codebase - Hope this works
- Bug fixes and improvements - Fixed some bugs - Made various improvements
- Work in progress - Some changes I'm working on - Not sure if it's correct yet
- Final update - Last-minute changes before the deadline - Crossing fingers it's all good now

In the bad examples, the commit messages lack clarity, specific details, and fail to follow the imperative mood guideline. They provide little insight into the nature of the changes, making it challenging for collaborators to understand the purpose of each commit.
