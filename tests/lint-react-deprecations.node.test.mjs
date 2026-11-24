import assert from "node:assert/strict";
import { test } from "node:test";
import { Linter } from "eslint";
import reactDeprecations from "../scripts/lint/react-deprecations.mjs";

const linter = new Linter();
const config = {
  languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
  plugins: { yaseir: { rules: { "react-no-deprecated": reactDeprecations } } },
  rules: { "yaseir/react-no-deprecated": "error" },
};
const bad = [
  "React.renderComponent(node, target);",
  "React.renderComponentToString(node);",
  "React.renderComponentToStaticMarkup(node);",
  "React.isValidComponent(node);",
  "React.PropTypes.component;",
  "React.PropTypes.renderable;",
  "React.isValidClass(node);",
  "this.transferPropsTo(node);",
  "React.addons.classSet({});",
  "React.addons.cloneWithProps(node, {});",
  "React.render(node, target);",
  "React.unmountComponentAtNode(target);",
  "React.findDOMNode(node);",
  "React.renderToString(node);",
  "React.renderToStaticMarkup(node);",
  "React.addons.LinkedStateMixin;",
  "ReactPerf.printDOM();",
  "Perf.getMeasurementsSummaryMap();",
  "React.createClass({});",
  "React.addons.TestUtils;",
  "React.PropTypes;",
  "React.DOM.div();",
  "ReactDOM.render(node, target);",
  "ReactDOM.hydrate(node, target);",
  "ReactDOM.unmountComponentAtNode(target);",
  "ReactDOMServer.renderToNodeStream(node);",
  "import { render as oldRender } from 'react-dom'; oldRender(node, target);",
  "const { hydrate } = require('react-dom'); hydrate(node, target);",
  "const { PropTypes } = React;",
  "class Example extends React.Component { componentWillMount() {} render() { return null; } }",
  "class Example extends Component { componentWillReceiveProps() {} render() { return null; } }",
  "const Example = class extends React.PureComponent { componentWillUpdate() {} render() { return null; } };",
  "const Example = React.createClass({ componentWillMount() {}, render() { return null; } });",
  "import Legacy from 'react-dom'; Legacy.hydrate(node, target);",
  "const { printDOM } = Perf;",
  "const { getMeasurementsSummaryMap } = Perf;",
  "/** @jsx UI.createElement */ UI.render(node, target);",
  "/** @jsx UI.createElement */ class Example extends UI.Component { componentWillMount() {} }",
  "/** @extends React.Component */ class Example extends Wrapped { componentWillReceiveProps() {} }",
  "/** @augments React.PureComponent */ const Example = class extends Wrapped { componentWillUpdate() {} };",
];

for (const code of bad) {
  test(`React 19 deprecation coverage: ${code}`, () => {
    const messages = linter.verify(code, config);
    assert.ok(messages.some((m) => m.ruleId === "yaseir/react-no-deprecated"), JSON.stringify(messages));
    assert.equal(messages.some((m) => m.fatal), false);
  });
}

for (const code of [
  "UI.render(node, target);",
  "class Example extends UI.PureComponent { componentWillUpdate() {} }",
  "const Example = customCreateClass({ componentWillMount() {} });",
  "const Example = UI.customCreateClass({ componentWillReceiveProps() {} });",
]) {
  test(`preserves configured React factory and pragma coverage: ${code}`, () => {
    const messages = linter.verify(code, { ...config, settings: { react: { pragma: "UI", createClass: "customCreateClass" } } });
    assert.ok(messages.some((m) => m.ruleId === "yaseir/react-no-deprecated"), JSON.stringify(messages));
    assert.equal(messages.some((m) => m.fatal), false);
  });
}

for (const code of [
  "import { createRoot } from 'react-dom/client'; createRoot(target).render(node);",
  "import { renderToPipeableStream } from 'react-dom/server'; renderToPipeableStream(node);",
  "class Other { componentWillMount() {} }",
  "const other = { componentWillReceiveProps() {} };",
  "const { render } = require('other-library'); render();",
  "class Example extends React.Component { componentDidMount() {} render() { return null; } }",
]) {
  test(`supported or unrelated React API: ${code}`, () => {
    const messages = linter.verify(code, config);
    assert.equal(messages.filter((m) => m.ruleId === "yaseir/react-no-deprecated").length, 0);
    assert.equal(messages.some((m) => m.fatal), false);
  });
}
