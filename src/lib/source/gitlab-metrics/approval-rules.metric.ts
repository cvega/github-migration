import { z } from "zod";
import { defineGitLabMetric } from "./define";

export const gitLabApprovalPolicySchema = z
  .object({
    requiresApprovals: z.boolean().nullable(),
    hasRequiredProtectedBranchRules: z.boolean().nullable(),
  })
  .strict();

export type GitLabApprovalPolicy = z.infer<typeof gitLabApprovalPolicySchema>;

export default defineGitLabMetric({
  key: "approvalRules",
  order: 14,
  card: { label: "Approval rules", icon: "check-circle", position: 15 },
  fields: gitLabApprovalPolicySchema.shape,
});
