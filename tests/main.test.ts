/*
 * Copyright 2021 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import 'mocha';
import { expect } from 'chai';
import * as sinon from 'sinon';

import YAML from 'yaml';
import * as path from 'path';
import * as fs from 'fs/promises';

import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as setupGcloud from '@google-github-actions/setup-cloud-sdk';
import { TestToolCache } from '@google-github-actions/setup-cloud-sdk';
import {
  errorMessage,
  forceRemove,
  KVPair,
  randomFilepath,
  writeSecureFile,
} from '@google-github-actions/actions-utils';

import { run, findAppYaml, updateEnvVars, parseDeliverables } from '../src/main';

// These are mock data for github actions inputs, where camel case is expected.
const fakeInputs: { [key: string]: string } = {
  project_id: '',
  working_directory: '',
  deliverables: 'example-app/app.yaml',
  image_url: '',
  env_vars: '',
  version: '',
  promote: '',
  flags: '',
};

function getInputMock(name: string): string {
  return fakeInputs[name];
}

describe('#run', function () {
  beforeEach(async function () {
    await TestToolCache.start();

    this.stubs = {
      getInput: sinon.stub(core, 'getInput').callsFake(getInputMock),
      exportVariable: sinon.stub(core, 'exportVariable'),
      setOutput: sinon.stub(core, 'setOutput'),
      authenticateGcloudSDK: sinon.stub(setupGcloud, 'authenticateGcloudSDK'),
      getLatestGcloudSDKVersion: sinon
        .stub(setupGcloud, 'getLatestGcloudSDKVersion')
        .resolves('1.2.3'),
      isInstalled: sinon.stub(setupGcloud, 'isInstalled').returns(true),
      installGcloudSDK: sinon.stub(setupGcloud, 'installGcloudSDK'),
      installComponent: sinon.stub(setupGcloud, 'installComponent'),
      getExecOutput: sinon
        .stub(exec, 'getExecOutput')
        .onFirstCall()
        .resolves({ exitCode: 0, stderr: '', stdout: testDeployResponse })
        .onSecondCall()
        .resolves({ exitCode: 0, stderr: '', stdout: testDescribeResponse }),
    };

    sinon.stub(core, 'setFailed').throwsArg(0); // make setFailed throw exceptions
    sinon.stub(core, 'addPath').callsFake(sinon.fake());
    sinon.stub(core, 'debug').callsFake(sinon.fake());
    sinon.stub(core, 'endGroup').callsFake(sinon.fake());
    sinon.stub(core, 'info').callsFake(sinon.fake());
    sinon.stub(core, 'startGroup').callsFake(sinon.fake());
    sinon.stub(core, 'warning').callsFake(sinon.fake());
  });

  afterEach(async function () {
    Object.keys(this.stubs).forEach((k) => this.stubs[k].restore());
    sinon.restore();

    await TestToolCache.stop();
  });

  it('installs the gcloud SDK if it is not already installed', async function () {
    this.stubs.isInstalled.returns(false);
    await run();
    expect(this.stubs.installGcloudSDK.callCount).to.eq(1);
  });

  it('uses the cached gcloud SDK if it was already installed', async function () {
    this.stubs.isInstalled.returns(true);
    await run();
    expect(this.stubs.installGcloudSDK.callCount).to.eq(0);
  });

  it('uses default components without gcloud_component flag', async function () {
    await run();
    expect(this.stubs.installComponent.callCount).to.eq(0);
  });

  it('throws error with invalid gcloud component flag', async function () {
    this.stubs.getInput.withArgs('gcloud_component').returns('wrong_value');
    await expectError(run, 'invalid value for gcloud_component: wrong_value');
  });

  it('installs alpha component with alpha flag', async function () {
    this.stubs.getInput.withArgs('gcloud_component').returns('alpha');
    await run();
    expect(this.stubs.installComponent.withArgs('alpha').callCount).to.eq(1);
  });

  it('installs beta component with beta flag', async function () {
    this.stubs.getInput.withArgs('gcloud_component').returns('beta');
    await run();
    expect(this.stubs.installComponent.withArgs('beta').callCount).to.eq(1);
  });

  it('sets project if provided', async function () {
    this.stubs.getInput.withArgs('project_id').returns('my-test-project');
    await run();

    const call = this.stubs.getExecOutput.getCall(0);
    expect(call).to.be;
    const args = call.args[1];
    expect(args).to.include.members(['--project', 'my-test-project']);
  });

  it('sets image-url if provided', async function () {
    this.stubs.getInput.withArgs('image_url').returns('gcr.io/foo/bar');
    await run();

    const call = this.stubs.getExecOutput.getCall(0);
    expect(call).to.be;
    const args = call.args[1];
    expect(args).to.include.members(['--image-url', 'gcr.io/foo/bar']);
  });

  it('sets version if provided', async function () {
    this.stubs.getInput.withArgs('version').returns('123');
    await run();

    const call = this.stubs.getExecOutput.getCall(0);
    expect(call).to.be;
    const args = call.args[1];
    expect(args).to.include.members(['--version', '123']);
  });

  it('sets promote if provided', async function () {
    this.stubs.getInput.withArgs('promote').returns('true');
    await run();

    const call = this.stubs.getExecOutput.getCall(0);
    expect(call).to.be;
    const args = call.args[1];
    expect(args).to.include.members(['--promote']);
  });

  it('sets no-promote if not provided', async function () {
    this.stubs.getInput.withArgs('promote').returns('false');
    await run();

    const call = this.stubs.getExecOutput.getCall(0);
    expect(call).to.be;
    const args = call.args[1];
    expect(args).to.include.members(['--no-promote']);
  });

  it('sets flags if provided', async function () {
    this.stubs.getInput.withArgs('flags').returns('--log-http   --foo=bar');
    await run();

    const call = this.stubs.getExecOutput.getCall(0);
    expect(call).to.be;
    const args = call.args[1];
    expect(args).to.include.members(['--log-http', '--foo', 'bar']);
  });

  it('sets outputs', async function () {
    await run();

    const setOutput = this.stubs.setOutput;
    expect(
      setOutput.calledWith('name', 'apps/my-project/services/default/versions/20221215t102539'),
    ).to.be.ok;
    expect(setOutput.calledWith('runtime', 'nodejs16')).to.be.ok;
    expect(setOutput.calledWith('service_account_email', 'my-project@appspot.gserviceaccount.com'))
      .to.be.ok;
    expect(setOutput.calledWith('serving_status', 'SERVING')).to.be.ok;
    expect(setOutput.calledWith('version_id', '20221215t102539')).to.be.ok;
    expect(
      setOutput.calledWith('version_url', 'https://20221215t102539-dot-my-project.appspot.com'),
    ).to.be.ok;
    expect(setOutput.calledWith('url', 'https://20221215t102539-dot-my-project.appspot.com')).to.be
      .ok;
  });
});

describe('#findAppYaml', () => {
  beforeEach(async function () {
    this.parent = randomFilepath();
    await fs.mkdir(this.parent, { recursive: true });
  });

  afterEach(async function () {
    if (this.parent) {
      forceRemove(this.parent);
    }
  });

  const cases: {
    only?: boolean;
    name: string;
    files: Record<string, string>;
    expected?: string;
    error?: string;
  }[] = [
    {
      name: 'no deployables',
      files: {},
      error: 'could not find an appyaml',
    },
    {
      name: 'no appyaml single',
      files: {
        'my-file': `
this is a file
      `,
      },
      error: 'could not find an appyaml',
    },
    {
      name: 'no appyaml multiple',
      files: {
        'my-file': `
this is a file
      `,
        'my-other-file': `
this is another file
      `,
      },
      error: 'could not find an appyaml',
    },
    {
      name: 'single appyaml',
      files: {
        'app-dev.yaml': `
runtime: 'node'
      `,
      },
      expected: 'app-dev.yaml',
    },
    {
      name: 'multiple files with appyaml',
      files: {
        'my-file': `
this is a file
      `,
        'my-other-file': `
this is another file
      `,
        'app-prod.yaml': `
runtime: 'node'
      `,
      },
      expected: 'app-prod.yaml',
    },
    {
      name: 'multiple appyaml uses first',
      files: {
        'app.yaml': `
runtime: 'node'
service: 'my-service'
      `,
        'app-dev.yaml': `
runtime: 'node'
service: 'my-service'
env: 'flex'
      `,
        'app-prod.yaml': `
runtime: 'node'
service: 'my-service'
env: 'standard'
      `,
      },
      expected: 'app.yaml',
    },
  ];

  cases.forEach((tc) => {
    const fn = tc.only ? it.only : it;
    fn(tc.name, async function () {
      Object.keys(tc.files).map((key) => {
        const newKey = path.join(this.parent, key);
        tc.files[newKey] = tc.files[key];
        delete tc.files[key];
      });

      await Promise.all(
        Object.entries(tc.files).map(async ([pth, contents]) => {
          await writeSecureFile(pth, contents);
        }),
      );

      const filepaths = Object.keys(tc.files);
      if (tc.error) {
        expectError(async () => {
          await findAppYaml(filepaths);
        }, tc.error);
      } else if (tc.expected) {
        const expected = path.join(this.parent, tc.expected);
        const result = await findAppYaml(filepaths);
        expect(result).to.eql(expected);
      }
    });
  });
});

describe('#updateEnvVars', () => {
  const cases: {
    only?: boolean;
    name: string;
    existing: KVPair;
    envVars: KVPair;
    expected: KVPair;
  }[] = [
    {
      name: 'empty existing, empty input',
      existing: {},
      envVars: {},
      expected: {},
    },
    {
      name: 'empty existing, given input',
      existing: {},
      envVars: {
        FOO: 'bar',
        ZIP: 'zap',
      },
      expected: {
        FOO: 'bar',
        ZIP: 'zap',
      },
    },
    {
      name: 'existing, given input',
      existing: {
        EXISTING: 'one',
      },
      envVars: {
        FOO: 'bar',
        ZIP: 'zap',
      },
      expected: {
        EXISTING: 'one',
        FOO: 'bar',
        ZIP: 'zap',
      },
    },
    {
      name: 'overwrites',
      existing: {
        FOO: 'bar',
      },
      envVars: {
        FOO: 'zip',
      },
      expected: {
        FOO: 'zip',
      },
    },
  ];

  cases.forEach((tc) => {
    const fn = tc.only ? it.only : it;
    fn(tc.name, () => {
      expect(updateEnvVars(tc.existing, tc.envVars)).to.eql(tc.expected);
    });
  });

  it('handles an yaml with variables', async () => {
    const parsed = YAML.parse(`
      env_variables:
        FOO: 'bar'
    `);

    console.log(typeof parsed.env_variables);
    const result = updateEnvVars(parsed.env_variables, { ZIP: 'zap' });
    expect(result).to.eql({
      FOO: 'bar',
      ZIP: 'zap',
    });
  });

  it('handles an yaml without variables', async () => {
    const parsed = YAML.parse(`{}`);

    console.log(typeof parsed.env_variables);
    const result = updateEnvVars(parsed.env_variables, { ZIP: 'zap' });
    expect(result).to.eql({
      ZIP: 'zap',
    });
  });
});

describe('#parseDeliverables', () => {
  const cases: {
    only?: boolean;
    name: string;
    input: string;
    expected?: string[];
  }[] = [
    {
      name: 'empty',
      input: '',
      expected: [],
    },
    {
      name: 'single',
      input: 'app.yaml',
      expected: ['app.yaml'],
    },
    {
      name: 'multi space',
      input: 'app.yaml foo.yaml',
      expected: ['app.yaml', 'foo.yaml'],
    },
    {
      name: 'multi comma',
      input: 'app.yaml, foo.yaml',
      expected: ['app.yaml', 'foo.yaml'],
    },
    {
      name: 'multi comma space',
      input: 'app.yaml,foo.yaml,   bar.yaml',
      expected: ['app.yaml', 'foo.yaml', 'bar.yaml'],
    },
    {
      name: 'multi-line comma space',
      input: 'app.yaml,\nfoo.yaml,   bar.yaml',
      expected: ['app.yaml', 'foo.yaml', 'bar.yaml'],
    },
  ];

  cases.forEach((tc) => {
    const fn = tc.only ? it.only : it;
    fn(tc.name, () => {
      expect(parseDeliverables(tc.input)).to.eql(tc.expected);
    });
  });
});

async function expectError(fn: () => Promise<void>, want: string) {
  try {
    await fn();
    throw new Error(`expected error`);
  } catch (err) {
    const msg = errorMessage(err);
    expect(msg).to.include(want);
  }
}

const testDeployResponse = `
{
  "configs": [],
  "versions": [
    {
      "environment": null,
      "id": "123",
      "last_deployed_time": null,
      "project": "my-project",
      "service": "default",
      "service_account": null,
      "traffic_split": null,
      "version": null
    }
  ]
}
`;

const testDescribeResponse = `
{
  "createTime": "2022-12-15T15:26:11Z",
  "createdBy": "foo@bar.com",
  "deployment": {
    "files": {
      "app.yaml": {
        "sha1Sum": "84a6883be145d40d7f34901050f403f51faba608",
        "sourceUrl": "https://storage.googleapis.com/staging.my-project.appspot.com/84a6883be145d40d7f34901050f403f51faba608"
      }
    }
  },
  "diskUsageBytes": "4288402",
  "env": "standard",
  "id": "20221215t102539",
  "instanceClass": "F1",
  "name": "apps/my-project/services/default/versions/20221215t102539",
  "network": {},
  "runtime": "nodejs16",
  "runtimeChannel": "default",
  "serviceAccount": "my-project@appspot.gserviceaccount.com",
  "servingStatus": "SERVING",
  "threadsafe": true,
  "versionUrl": "https://20221215t102539-dot-my-project.appspot.com"
}
`;
