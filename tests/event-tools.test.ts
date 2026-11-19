import { describe, expect, it } from 'vitest';
import { eventPatchSchema, eventSchema, reminderSchema, todoSchema } from '../src/server/domain.js';
import { buildTools, type ToolContext } from '../src/server/tools.js';

describe('Calendar tool contracts', () => {
  const tools = buildTools({ signal: new AbortController().signal } as ToolContext);
  const parameters = (name: string) =>
    tools.find((tool) => tool.name === name)!.parameters as {
      properties: Record<string, unknown>;
      required: string[];
    };
  it('exposes every editable event field plus direct read and cancellation tools', () => {
    const schema = parameters('update_event');
    expect(Object.keys(schema.properties).sort()).toEqual(
      [
        'event_id',
        'status',
        'add_reminders',
        ...Object.keys(eventSchema.shape).filter((key) => key !== 'reminders'),
      ].sort(),
    );
    expect(schema.required).toEqual(['event_id']);
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'create_event',
        'get_event',
        'get_agenda',
        'update_event',
        'cancel_event',
      ]),
    );
  });
  it('covers task date precision, scheduling, notes, clearing fields and linked alerts in Agent tools', () => {
    expect(Object.keys(parameters('create_event').properties)).toEqual(
      expect.arrayContaining(Object.keys(eventSchema.shape)),
    );
    expect(Object.keys(parameters('create_todo').properties)).toEqual(
      expect.arrayContaining(Object.keys(todoSchema.shape)),
    );
    expect(Object.keys(parameters('update_todo').properties).sort()).toEqual(
      [
        'todo_id',
        'status',
        'add_reminders',
        ...Object.keys(todoSchema.shape).filter((key) => key !== 'reminders'),
      ].sort(),
    );
    expect(parameters('get_todo').required).toEqual(['todo_id']);
    expect(parameters('create_event').required).toEqual(['title']);
    expect(parameters('create_todo').required).toEqual(['title']);
  });
  it('exposes all reminder settings, including relative offsets and removable links', () => {
    expect(Object.keys(parameters('update_reminder').properties).sort()).toEqual(
      ['reminder_id', ...Object.keys(reminderSchema.shape)].sort(),
    );
    expect(parameters('update_reminder').required).toEqual(['reminder_id']);
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['get_reminder', 'cancel_reminder']),
    );
  });
});
describe('Partial event updates preserve omitted fields', () => {
  it('does not apply creation defaults when only location, title or status changes', () => {
    for (const patch of [
      { location: '科苑地铁站附近' },
      { title: '改标题' },
      { status: 'cancelled' },
    ])
      expect(eventPatchSchema.parse(patch)).toEqual(patch);
  });
  it('can clear optional fields explicitly and rejects an empty or unknown-field patch', () => {
    const clear = { location: '', notes: '', person_id: null, recording_id: null };
    expect(eventPatchSchema.parse(clear)).toEqual(clear);
    expect(() => eventPatchSchema.parse({})).toThrow();
    expect(() => eventPatchSchema.parse({ id: 'replacement' })).toThrow();
  });
});
