// React 19 replacement for the active eslint-plugin-react/no-deprecated rule.
// The API inventory follows jsx-eslint/eslint-plugin-react 7.37.5 (MIT).
// This implementation uses ESLint 10's public API, with no compatibility shim.
const modules = {
  react: "React", "react-dom": "ReactDOM", "react-dom/server": "ReactDOMServer",
  "react-addons-perf": "ReactPerf",
};
const deprecated = new Set([
  "React.renderComponent", "React.renderComponentToString", "React.renderComponentToStaticMarkup",
  "React.isValidComponent", "React.PropTypes.component", "React.PropTypes.renderable", "React.isValidClass",
  "this.transferPropsTo", "React.addons.classSet", "React.addons.cloneWithProps", "React.render",
  "React.unmountComponentAtNode", "React.findDOMNode", "React.renderToString", "React.renderToStaticMarkup",
  "React.addons.LinkedStateMixin", "ReactPerf.printDOM", "Perf.printDOM",
  "ReactPerf.getMeasurementsSummaryMap", "Perf.getMeasurementsSummaryMap", "React.createClass",
  "React.addons.TestUtils", "React.PropTypes", "React.DOM", "ReactDOM.render", "ReactDOM.hydrate",
  "ReactDOM.unmountComponentAtNode", "ReactDOMServer.renderToNodeStream",
]);
const lifecycle = new Set(["componentWillMount", "componentWillReceiveProps", "componentWillUpdate"]);
const propertyName = (n) => n?.type === "Identifier" ? n.name : typeof n?.value === "string" ? n.value : null;

const reactDeprecations = {
  meta: {
    type: "problem",
    schema: [],
    docs: { description: "Reject legacy APIs and component lifecycle methods deprecated before React 19" },
    messages: { deprecated: "{{name}} is deprecated in the installed React 19 runtime." },
  },
  create(context) {
    const aliases = new Map(Object.values(modules).map((name) => [name, name]));
    aliases.set("Perf", "ReactPerf");
    const annotation = context.sourceCode.getAllComments()
      .map((comment) => /@jsx\s+([^\s]+)/.exec(comment.value)).find(Boolean);
    const configuredPragma = annotation?.[1].split(".")[0] ?? context.settings.react?.pragma ?? "React";
    const pragma = /^[_$a-zA-Z][_$a-zA-Z0-9]*$/.test(configuredPragma) ? configuredPragma : "React";
    aliases.set(pragma, "React");
    const createClass = context.settings.react?.createClass ?? "createReactClass";
    const components = new Set(["Component", "PureComponent"]);
    function path(node) {
      if (node?.type === "Identifier") return aliases.get(node.name) || node.name;
      if (node?.type === "ThisExpression") return "this";
      if (node?.type === "MemberExpression") {
        const base = path(node.object);
        const property = !node.computed || node.property.type === "Literal" ? propertyName(node.property) : null;
        return base && property ? `${base}.${property}` : null;
      }
      return null;
    }
    function report(node, name) {
      if (deprecated.has(name)) context.report({ node, messageId: "deprecated", data: { name } });
    }
    function checkMethods(properties) {
      for (const property of properties) {
        const name = propertyName(property.key);
        if (lifecycle.has(name)) context.report({ node: property.key, messageId: "deprecated", data: { name } });
      }
    }
    function checkClass(node) {
      const parent = path(node.superClass);
      let declaration = node;
      if (declaration.parent?.type === "VariableDeclarator" && declaration.parent.init === declaration) {
        declaration = declaration.parent.parent;
      }
      if (["ExportDefaultDeclaration", "ExportNamedDeclaration"].includes(declaration.parent?.type)) {
        declaration = declaration.parent;
      }
      const comment = context.sourceCode.getCommentsBefore(declaration).at(-1);
      const explicitComponent = comment?.type === "Block" && comment.value.startsWith("*")
        && /@(?:extends|augments)\s+(?:\{)?React\.(?:Pure)?Component(?:\})?(?=\s|$)/.test(comment.value);
      if (parent === "React.Component" || parent === "React.PureComponent" || components.has(parent) || explicitComponent) {
        checkMethods(node.body.body);
      }
    }
    return {
      ImportDeclaration(node) {
        const moduleName = modules[node.source.value];
        if (!moduleName) return;
        for (const spec of node.specifiers) {
          if (spec.type === "ImportDefaultSpecifier" || spec.type === "ImportNamespaceSpecifier") {
            aliases.set(spec.local.name, moduleName);
          } else {
            const name = propertyName(spec.imported);
            report(spec, `${moduleName}.${name}`);
            if (moduleName === "React" && (name === "Component" || name === "PureComponent")) components.add(spec.local.name);
          }
        }
      },
      MemberExpression(node) { report(node, path(node)); },
      VariableDeclarator(node) {
        const init = node.init;
        const moduleName = init?.type === "CallExpression" && init.callee.type === "Identifier" && init.callee.name === "require"
          ? modules[init.arguments[0]?.value] : aliases.get(init?.name);
        if (!moduleName) return;
        if (node.id.type === "Identifier") aliases.set(node.id.name, moduleName);
        if (node.id.type === "ObjectPattern") {
          for (const property of node.id.properties) {
            if (property.type === "Property") report(property, `${moduleName}.${propertyName(property.key)}`);
          }
        }
      },
      ClassDeclaration: checkClass,
      ClassExpression: checkClass,
      ObjectExpression(node) {
        const parent = node.parent;
        if (parent?.type === "CallExpression" && parent.arguments[0] === node
          && ["React.createClass", createClass, `React.${createClass}`].includes(path(parent.callee))) checkMethods(node.properties);
      },
    };
  },
};

export default reactDeprecations;
