// 规则的唯一一份在 chat-protocol（主进程的子会话大纲也用它，§19.7）；这里转出，旧引用不断
export {
  formatStepSequence,
  groupConsecutiveSteps,
  summarizeSteps,
  uniformToolName,
  type BlockGroup,
  type StepBlock,
  type StepSequenceItem
} from '@shuvix/chat-protocol/utils/stepGrouping'
