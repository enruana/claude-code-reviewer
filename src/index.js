const core = require('@actions/core');
const github = require('@actions/github');
const { getRepositoryContent, minifyContent } = require('./utils');
const Anthropic = require('@anthropic-ai/sdk');

const main = async () => {

  // auth with github
  const token = core.getInput('github-token', { required: true });
  const octokit = github.getOctokit(token)

  // auth with anthropic
  const anthropicApiKey = core.getInput('anthropic-api-key', { required: true });
  const anthropic = new Anthropic({
    apiKey: anthropicApiKey,
  });

  // getting PR data 
  const context = github.context;
  const { owner, repo } = context.repo;
  const pull_number = context.payload.pull_request ? context.payload.pull_request.number : context.payload.issue.number;

  core.info("Fetching PR details...");
  const { data: pullRequest } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number,
  });

  core.info("Fetching repository content...");
  const repoContent = await getRepositoryContent();

  const repoContentString = Object.entries(repoContent)
    .map(([file, content]) => `File: ${file}\n\n${minifyContent(content)}`)
    .join('\n\n---\n\n');


  let promptText;
  if (context.payload.comment) {
    promptText = `Latest comment on the pull request:\n${context.payload.comment.body}`;
  } else {
    promptText = `Pull Request Description:\n${pullRequest.body}`;
  }

  core.info(`Prompt text: ${promptText}`);

  const initialPrompt = `
      You are an AI assistant tasked with suggesting changes to a GitHub repository based on a pull request comment or description.
      Below is the current structure and content of the repository, followed by the latest comment or pull request description.
      Please analyze the repository content and the provided text, then suggest appropriate changes.

      Repository content (minified):
      ${repoContentString}
      
      Description/Comment:
      ${promptText}
      
      <instructions>
      Based on the repository content and the provided text, suggest changes to the codebase. 
      Format your response as a series of git commands that can be executed to make the changes.
      Each command should be on a new line and start with 'git'.
      For file content changes, use 'git add' followed by the file path, then provide the new content between <<<EOF and EOF>>> markers.
      Ensure all file paths are valid and use forward slashes.
      Consider the overall architecture and coding style of the existing codebase when suggesting changes.
      If not directly related to the requested changes, don't make code changes to those parts. we want to keep consistency and stability with each iteration
      If the provided text is vague, don't make any changes.
      If no changes are necessary or if the request is unclear, state so explicitly.
      When you have finished suggesting all changes, end your response with the line END_OF_SUGGESTIONS.
      </instructions>

      Base branch: ${pullRequest.base.ref}
    `;


  const message = await anthropic.messages.create({
    model: "claude-3-5-sonnet-20240620",
    max_tokens: 1024,
    messages: [{ role: "user", content: initialPrompt }],
  });

  const claudeResponse = message.content.map((content) => content.text).join('\n');

  core.info(`Claude's response: ${claudeResponse}`);

  const commands = claudeResponse.split('\n').map((command) => command.trim()).filter((command) => command);

  for (const command of commands) {
    if (command.startsWith('git add')) {
      const filePath = command.split(' ').pop();
      const contentStart = claudeResponse.indexOf('<<<EOF', claudeResponse.indexOf(command));
      const contentEnd = claudeResponse.indexOf('EOF>>>', contentStart);
      if (contentStart === -1 || contentEnd === -1) {
        core.error(`Invalid content markers for file: ${filePath}`);
        continue;
      }
      console.log('command', command);
      const content = claudeResponse.slice(contentStart + 6, contentEnd).trim();

      try {
        // First, try to get the current file content and SHA
        const { data: fileData } = await octokit.rest.repos.getContent({
          owner,
          repo,
          path: filePath,
          ref: pullRequest.head.ref,
        });

        // Update the file
        await octokit.rest.repos.createOrUpdateFileContents({
          owner,
          repo,
          path: filePath,
          message: `Apply changes suggested by Claude 3.5`,
          content: Buffer.from(content).toString('base64'),
          sha: fileData.sha,
          branch: pullRequest.head.ref,
        });
      } catch (error) {
        // if (error.status === 404) {
        //   // File doesn't exist, so create it
        //   await octokit.rest.repos.createOrUpdateFileContents({
        //     owner,
        //     repo,
        //     path: filePath,
        //     message: `Create file suggested by Claude 3.5`,
        //     content: Buffer.from(content).toString('base64'),
        //     branch: pullRequest.head.ref,
        //   });
        // } else {
        //   throw error;
        // }
        throw error;
      }

      console.log('createOrUpdateFileContents', filePath);
      core.info(`Updated ${filePath}`);
    }
  }

  // const { data: files } = await octokit.rest.pulls.listFiles({
  //   owner,
  //   repo,
  //   pull_number,
  // });

  // if (files.length > 0) {
  //   await octokit.rest.issues.createComment({
  //     owner,
  //     repo,
  //     issue_number: pull_number,
  //     body: "Changes suggested by Claude 3.5 have been applied to this PR based on the latest comment. Please review the changes.",
  //   });
  // } else {
  //   core.info("No changes to commit.");
  //   await octokit.rest.issues.createComment({
  //     owner,
  //     repo,
  //     issue_number: pull_number,
  //     body: "Claude 3.5 analyzed the latest comment and the repository content but did not suggest any changes.",
  //   });
  // }

}

main();