import { submitResearchRelayJob } from "../../gateway/research-relay-http.js";
import { logVerbose } from "../../globals.js";
import type { CommandHandler } from "./commands-types.js";

const RESEARCH_PREFIX = "/research";

function parseResearchArgs(commandBodyNormalized: string): {
  topic?: string;
  label?: string;
  usageError?: string;
} {
  if (commandBodyNormalized === RESEARCH_PREFIX) {
    return {
      usageError: "Usage: /research [--label <label>] <topic>",
    };
  }
  if (!commandBodyNormalized.startsWith(`${RESEARCH_PREFIX} `)) {
    return {};
  }

  const rawArgs = commandBodyNormalized.slice(RESEARCH_PREFIX.length).trim();
  if (!rawArgs) {
    return {
      usageError: "Usage: /research [--label <label>] <topic>",
    };
  }

  if (!rawArgs.toLowerCase().startsWith("--label ")) {
    return { topic: rawArgs };
  }

  const afterLabel = rawArgs.slice("--label ".length).trim();
  if (!afterLabel) {
    return {
      usageError: "Usage: /research [--label <label>] <topic>",
    };
  }
  const firstSpace = afterLabel.search(/\s/);
  if (firstSpace <= 0) {
    return {
      usageError: "Usage: /research [--label <label>] <topic>",
    };
  }
  const label = afterLabel.slice(0, firstSpace).trim();
  const topic = afterLabel.slice(firstSpace).trim();
  if (!label || !topic) {
    return {
      usageError: "Usage: /research [--label <label>] <topic>",
    };
  }
  return { topic, label };
}

export const handleResearchCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const parsed = parseResearchArgs(params.command.commandBodyNormalized);
  if (!parsed.topic && !parsed.usageError) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /research from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
  if (parsed.usageError || !parsed.topic) {
    return {
      shouldContinue: false,
      reply: { text: parsed.usageError ?? "Usage: /research [--label <label>] <topic>" },
    };
  }

  const result = await submitResearchRelayJob({
    topic: parsed.topic,
    label: parsed.label,
    env: process.env,
  });
  if (!result.ok) {
    if (result.reason === "disabled") {
      return {
        shouldContinue: false,
        reply: { text: "Research relay is disabled on this gateway." },
      };
    }
    if (result.reason === "misconfigured") {
      return {
        shouldContinue: false,
        reply: { text: "Research relay is enabled but misconfigured on this gateway." },
      };
    }
    return {
      shouldContinue: false,
      reply: { text: `Failed to submit research job: ${result.error}` },
    };
  }

  return {
    shouldContinue: false,
    reply: {
      text: `Research submitted. job_id=${result.jobId} status=${result.status}`,
    },
  };
};
