import { Octokit } from '@octokit/rest'
import { Probot } from 'probot'
import {
  COMMAND_REGEX,
  TAURI_APPS_BOT,
  TAURI_BOT_ACC,
  TAURI_BOT_ACC_OCTOKIT,
  TAURI_ORG,
  UPSTREAM_LABEL,
  UPSTREAM_RESOLVED_LABEL,
} from './constants'
import {
  issueUpstreamedComment,
  upstreamIssueBody,
  upstreamIssueBodyPredicate,
  upstreamIssueResolved,
} from './templates'
import { getIssueFromUrl, isTauriOrgMemeber } from './util'

export default (app: Probot): void => {
  try {
    app.on('issue_comment.created', async (context) => {
      const matches = COMMAND_REGEX.exec(context.payload.comment.body)
      if (!matches) return

      const [, command, cOwner, cRepo] = matches
      if (command == 'upstream') {
        const { repository, sender } = context.payload

        if (
          // commands from bot is not allowed
          !context.isBot &&
          // only upstream if it is not the same repo
          !(cRepo === repository.name && cOwner === repository.owner.login) &&
          // only upstream to a repo that belongs to tauri-apps
          repository.owner.login === TAURI_ORG &&
          // only upstream from a user that is a memeber in tauri-apps org
          (await isTauriOrgMemeber(sender.login))
        ) {
          app.log.info(
            `Running \`/upstream\` command to ${cOwner}/${cRepo} from ${sender.login}.`
          )

          // create upstream issue
          const { title, body, html_url } = context.payload.issue
          const { html_url: upstreamIssueUrl } = (
            await TAURI_BOT_ACC_OCTOKIT.issues.create(
              context.issue({
                title,
                body: upstreamIssueBody(html_url, body ?? ''),
                labels: context.payload.issue.labels,
                repo: cRepo,
                owner: cOwner,
              })
            )
          ).data

          // comment on original issue
          await context.octokit.issues.createComment(
            context.issue({
              body: issueUpstreamedComment(upstreamIssueUrl),
              repo: repository.name,
              owner: cOwner,
            })
          )

          // add label
          await context.octokit.issues.addLabels(
            context.issue({
              labels: [UPSTREAM_LABEL],
              repo: repository.name,
              owner: cOwner,
            })
          )
        }
      }
    })

    app.on('issues.closed', async (context) => {
      const { repository, issue } = context.payload

      if (
        // an issue is closed in a tauri-apps repo
        repository.owner.login === TAURI_ORG &&
        // and was created by our bot
        (issue.user.login === TAURI_APPS_BOT ||
          // or was created by tauri-bot account
          issue.user.login === TAURI_BOT_ACC) &&
        // and it was from an upstream command
        issue.body?.startsWith(upstreamIssueBodyPredicate)
      ) {
        const originalIssueUrl = issue.body
          .replace(upstreamIssueBodyPredicate, '')
          .split('\n\n')[0]
          .trim()
        const originalIssue = await getIssueFromUrl(
          context.octokit,
          originalIssueUrl
        )
        if (!originalIssue?.repository) return

        // notify original issue that upstream is resolved
        await context.octokit.issues.createComment(
          context.issue({
            body: upstreamIssueResolved(issue.html_url),
            owner: originalIssue.repository.owner,
            repo: originalIssue.repository.name,
          })
        )

        // add upstream resolved label
        await context.octokit.issues.addLabels(
          context.issue({
            labels: [UPSTREAM_RESOLVED_LABEL],
            owner: originalIssue.repository.owner,
            repo: originalIssue.repository.name,
          })
        )

        // remove upstream label
        await context.octokit.issues.removeLabel(
          context.issue({
            name: UPSTREAM_LABEL,
            owner: originalIssue.repository.owner,
            repo: originalIssue.repository.name,
          })
        )
      }
    })
  } catch (e) {
    app.log.error(e as string)
  }
}
