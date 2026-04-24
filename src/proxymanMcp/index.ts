export {
    ProxymanMcpClient,
    ProxymanMcpError,
    getProxymanMcpClient,
    parseRuleId,
    parseRuleList,
} from './client.js';
export type {
    ProxymanRuleSummary,
    ProxymanRuleType,
    CreateScriptingRuleInput,
} from './client.js';
export {
    buildScriptContent,
    buildProxymanUrlPattern,
    buildRuleName,
    isOurRule,
    isOurRuleForSession,
    RULE_NAME_PREFIX,
} from './rule-template.js';
export type {
    MatcherFields,
    JsonPatchOp,
    StaticResponseShape,
    ResponseTransformShape,
    BuildScriptInput,
} from './rule-template.js';
