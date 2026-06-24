// lib/cli-grade.js — `forge grade <experiment>`
//
// A two-phase convenience wrapper over the existing judge/score pipeline. It
// exists because judging cannot be fully automated in one shot: an external
// gpt-5.5 sub-agent has to WRITE the verdicts between prompt generation and
// collection. Forge can orchestrate everything around that human/agent step but
// not the verdict authoring itself. `grade` therefore collapses the four-call
// dance (judge agent, dispatch, judge validate, judge collect, score) into two
// named phases:
//
//   forge grade <exp>             phase 1: generate judge prompts + emit the
//                                 gpt-5.5 dispatch contract.
//   forge grade <exp> --finalize  phase 2: validate verdicts, collect them,
//                                 then score.
//
// Each underlying step is run with stdout captured (see runStep `capture`) so
// grade emits exactly ONE JSON envelope, honoring the single-envelope contract.

// Parse the last JSON envelope from a captured child stdout blob. The child may
// interleave non-JSON lines, so scan from the end for the first parseable line.
function lastEnvelope(text) {
  const lines = String(text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // Not JSON; keep scanning upward.
    }
  }
  return null;
}

export async function runGrade({ experiment, pair = null, prev = null, finalize = false, runStep }) {
  const pairArgs = pair ? ['--pair', pair] : [];

  if (!finalize) {
    const out = await runStep({ step: 'judge', args: [...pairArgs, '--mode', 'agent'], capture: true });
    return {
      phase: 'prepare',
      experiment,
      judge: lastEnvelope(out),
      next: [
        `Dispatch a gpt-5.5 judge sub-agent to write the verdicts for the prompts just generated.`,
        `Run \`forge judge ${experiment} --dispatch-prompt\` to print the exact sub-agent contract.`,
        `When verdicts are written, run \`forge grade ${experiment} --finalize\` to validate, collect, and score.`,
      ],
    };
  }

  const validate = await runStep({ step: 'judge', args: [...pairArgs, '--mode', 'validate'], capture: true });
  const collect = await runStep({ step: 'judge', args: [...pairArgs, '--mode', 'collect'], capture: true });
  const scoreArgs = [...pairArgs];
  if (prev) {
    scoreArgs.push('--prev', prev);
  }
  const score = await runStep({ step: 'score', args: scoreArgs, capture: true });

  return {
    phase: 'finalize',
    experiment,
    validate: lastEnvelope(validate),
    collect: lastEnvelope(collect),
    score: lastEnvelope(score),
  };
}
