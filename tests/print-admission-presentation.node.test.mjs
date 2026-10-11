import { test } from 'node:test';
import assert from 'node:assert/strict';
import { persistedTimelinePresentation } from '../src/lib/job-timeline-presentation.ts';

test('historical success-looking printing event is rendered as pending admission', () => {
  assert.deepEqual(persistedTimelinePresentation({stage:'printing', status:'ok'}), {
    status:'pending', messageKey:'job.timeline.printingAdmitted',
  });
  assert.deepEqual(persistedTimelinePresentation({stage:'printing', status:'pending'}), {
    status:'pending', messageKey:'job.timeline.printingAdmitted',
  });
});

test('actual terminal status and error semantics remain unchanged', () => {
  assert.deepEqual(persistedTimelinePresentation({stage:'success',status:'ok'}), {
    status:'ok',messageKey:null,
  });
  assert.deepEqual(persistedTimelinePresentation({stage:'failed',status:'error'}), {
    status:'error',messageKey:null,
  });
});
