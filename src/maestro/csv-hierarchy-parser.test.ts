import { describe, it, expect } from 'vitest';
import { parseAttributes, parseCsvHierarchy } from './csv-hierarchy-parser.js';

describe('parseAttributes', () => {
  it('should parse semicolon-separated key=value pairs', () => {
    const input = 'accessibilityText=VILLAIN OS; resource-id=login_title; enabled=true';
    const result = parseAttributes(input);

    expect(result['accessibilityText']).toBe('VILLAIN OS');
    expect(result['resource-id']).toBe('login_title');
    expect(result['enabled']).toBe('true');
  });

  it('should handle empty string', () => {
    expect(parseAttributes('')).toEqual({});
  });

  it('should handle values containing equals signs', () => {
    const input = 'text=a=b; resource-id=field1';
    const result = parseAttributes(input);
    expect(result['text']).toBe('a=b');
    expect(result['resource-id']).toBe('field1');
  });

  it('should handle whitespace-only input', () => {
    expect(parseAttributes('   ')).toEqual({});
  });

  it('should handle single attribute', () => {
    const result = parseAttributes('enabled=true');
    expect(result).toEqual({ enabled: 'true' });
  });
});

describe('parseCsvHierarchy', () => {
  const SAMPLE_CSV = [
    'element_num,depth,bounds,attributes,parent_num',
    '1,0,"[0,0][393,852]","class=Application; resource-id=com.example.app",0',
    '2,1,"[0,0][393,852]","class=View; resource-id=main_container",1',
    '3,2,"[68,255][333,312]","accessibilityText=VILLAIN OS; resource-id=login_title; enabled=true",2',
    '4,2,"[55,492][346,551]","value=admin; text=admin; hintText=ENTER USERNAME; resource-id=login_username_field; enabled=true",2',
    '5,2,"[120,600][280,660]","accessibilityText=Sign In; resource-id=login_submit_button; class=Button; enabled=true",2',
  ].join('\n');

  it('should parse CSV with header into UIHierarchyNode tree', () => {
    const root = parseCsvHierarchy(SAMPLE_CSV);

    expect(root.role).toBe('Application');
    expect(root.id).toBe('com.example.app');
    expect(root.children).toHaveLength(1);

    const container = root.children[0];
    expect(container.id).toBe('main_container');
    expect(container.children).toHaveLength(3);
  });

  it('should extract accessibility labels from accessibilityText', () => {
    const root = parseCsvHierarchy(SAMPLE_CSV);
    const title = root.children[0].children[0];

    expect(title.accessibilityLabel).toBe('VILLAIN OS');
    expect(title.id).toBe('login_title');
  });

  it('should extract text and value attributes', () => {
    const root = parseCsvHierarchy(SAMPLE_CSV);
    const textField = root.children[0].children[1];

    expect(textField.text).toBe('admin');
    expect(textField.id).toBe('login_username_field');
  });

  it('should extract role from class attribute', () => {
    const root = parseCsvHierarchy(SAMPLE_CSV);
    const button = root.children[0].children[2];

    expect(button.role).toBe('Button');
    expect(button.id).toBe('login_submit_button');
    expect(button.accessibilityLabel).toBe('Sign In');
  });

  it('should return empty Application node for empty input', () => {
    const root = parseCsvHierarchy('');
    expect(root.role).toBe('Application');
    expect(root.children).toHaveLength(0);
  });

  it('should return empty Application node for header-only input', () => {
    const root = parseCsvHierarchy('element_num,depth,bounds,attributes,parent_num');
    expect(root.role).toBe('Application');
    expect(root.children).toHaveLength(0);
  });

  it('should handle CSV without header row', () => {
    const csvNoHeader = [
      '1,0,"[0,0][393,852]","class=View; resource-id=root",0',
      '2,1,"[10,10][100,100]","text=Hello; resource-id=greeting",1',
    ].join('\n');

    const root = parseCsvHierarchy(csvNoHeader);
    expect(root.id).toBe('root');
    expect(root.children).toHaveLength(1);
    expect(root.children[0].text).toBe('Hello');
  });

  it('should handle deeply nested hierarchies', () => {
    const deepCsv = [
      'element_num,depth,bounds,attributes,parent_num',
      '1,0,"[0,0][100,100]","class=View; resource-id=level0",0',
      '2,1,"[0,0][100,100]","class=View; resource-id=level1",1',
      '3,2,"[0,0][100,100]","class=View; resource-id=level2",2',
      '4,3,"[0,0][100,100]","text=Leaf; resource-id=level3",3',
    ].join('\n');

    const root = parseCsvHierarchy(deepCsv);
    expect(root.id).toBe('level0');
    expect(root.children[0].id).toBe('level1');
    expect(root.children[0].children[0].id).toBe('level2');
    expect(root.children[0].children[0].children[0].text).toBe('Leaf');
  });

  it('should handle multiple children at the same depth', () => {
    const siblingsCsv = [
      'element_num,depth,bounds,attributes,parent_num',
      '1,0,"[0,0][400,800]","class=View; resource-id=parent",0',
      '2,1,"[0,0][200,400]","resource-id=child_a",1',
      '3,1,"[200,0][400,400]","resource-id=child_b",1',
      '4,1,"[0,400][400,800]","resource-id=child_c",1',
    ].join('\n');

    const root = parseCsvHierarchy(siblingsCsv);
    expect(root.children).toHaveLength(3);
    expect(root.children[0].id).toBe('child_a');
    expect(root.children[1].id).toBe('child_b');
    expect(root.children[2].id).toBe('child_c');
  });
});
