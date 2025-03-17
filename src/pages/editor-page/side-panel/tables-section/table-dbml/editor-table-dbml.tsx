import React, {
    useState,
    useCallback,
    useMemo,
    useEffect,
    useRef,
} from 'react';
import type { DBTable } from '@/lib/domain/db-table';
import { useChartDB } from '@/hooks/use-chartdb';
import { useTheme } from '@/hooks/use-theme';
import { CodeSnippet } from '@/components/code-snippet/code-snippet';
import type { EffectiveTheme } from '@/context/theme-context/theme-context';
import { importer, Parser } from '@dbml/core';
import { exportBaseSQL } from '@/lib/data/export-metadata/export-sql-script';
import type { Diagram } from '@/lib/domain/diagram';
import { useToast } from '@/components/toast/use-toast';
import { setupDBMLLanguage } from '@/components/code-snippet/languages/dbml-language';
import { DatabaseType } from '@/lib/domain/database-type';
import { Button } from '@/components/button/button';
import { debounce, generateId, getOperatingSystem } from '@/lib/utils';
import { importDBMLToDiagram } from '@/lib/dbml-import';
import { useMonaco } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import type { DBRelationship } from '@/lib/domain/db-relationship';
import { useHotkeys } from 'react-hotkeys-hook';

export interface TableDBMLProps {
    filteredTables: DBTable[];
    toggleEditMode?: () => boolean;
}

const getEditorTheme = (theme: EffectiveTheme) => {
    return theme === 'dark' ? 'dbml-dark' : 'dbml-light';
};

interface DBMLError {
    message: string;
    line: number;
    column: number;
}

function parseDBMLError(error: unknown): DBMLError | null {
    try {
        if (typeof error === 'string') {
            const parsed = JSON.parse(error);
            if (parsed.diags?.[0]) {
                const diag = parsed.diags[0];
                return {
                    message: diag.message,
                    line: diag.location.start.line,
                    column: diag.location.start.column,
                };
            }
        } else if (error && typeof error === 'object' && 'diags' in error) {
            const parsed = error as {
                diags: Array<{
                    message: string;
                    location: { start: { line: number; column: number } };
                }>;
            };
            if (parsed.diags?.[0]) {
                return {
                    message: parsed.diags[0].message,
                    line: parsed.diags[0].location.start.line,
                    column: parsed.diags[0].location.start.column,
                };
            }
        }
    } catch (e) {
        console.error('Error parsing DBML error:', e);
    }
    return null;
}

const databaseTypeToImportFormat = (
    type: DatabaseType
): 'mysql' | 'postgres' | 'mssql' => {
    switch (type) {
        case DatabaseType.SQL_SERVER:
            return 'mssql';
        case DatabaseType.MYSQL:
        case DatabaseType.MARIADB:
            return 'mysql';
        case DatabaseType.POSTGRESQL:
        case DatabaseType.COCKROACHDB:
        case DatabaseType.SQLITE:
            return 'postgres';
        default:
            return 'postgres';
    }
};

export const EditorTableDBML: React.FC<TableDBMLProps> = ({
    filteredTables,
    toggleEditMode,
}) => {
    const {
        currentDiagram,
        updateTablesState,
        addTables,
        removeRelationships,
        removeTables,
        addRelationships,
    } = useChartDB();
    const { effectiveTheme } = useTheme();
    const { toast } = useToast();
    const [dbmlContent, setDbmlContent] = useState<string>('');
    const [dbmlError, setDbmlError] = useState<DBMLError | null>(null);
    const [isDirty, setIsDirty] = useState(false);
    const monacoInstance = useMonaco();
    const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
    const applyButtonRef = useRef<HTMLButtonElement>(null);
    const operatingSystem = useMemo(() => getOperatingSystem(), []);

    // Local storage key for auto-saving DBML content
    const dbmlStorageKey = `chartdb_dbml_edit_${currentDiagram.id}`;

    // Keep track of the original generated DBML for comparison
    const [originalDbmlContent, setOriginalDbmlContent] = useState<string>('');

    // Track diagram version for change detection
    const [diagramVersion, setDiagramVersion] = useState<string>('');
    const lastProcessedDiagramRef = useRef<string>('');

    // Generate a diagram version string to detect changes
    const currentDiagramVersion = useMemo(() => {
        // Create a version string based on tables, fields, and relationships
        const tablesVersion = currentDiagram.tables
            ?.map((table) => {
                // Include field details to detect field-level changes
                const fieldsHash = table.fields
                    .map(
                        (field) =>
                            `${field.id}-${field.name}-${field.type}-${field.primaryKey ? 1 : 0}-${field.nullable ? 1 : 0}`
                    )
                    .join(',');

                // Include indexes to detect index changes
                const indexesHash = (table.indexes || [])
                    .map(
                        (index) =>
                            `${index.id}-${index.name}-${index.unique ? 1 : 0}`
                    )
                    .join(',');

                return `${table.id}-${table.name}-${table.schema}-${fieldsHash}-${indexesHash}-${
                    table.createdAt || 0
                }`;
            })
            .join('|');

        const relationshipsVersion = currentDiagram.relationships
            ?.map((rel) => {
                return `${rel.id}-${rel.sourceTableId}-${rel.targetTableId}-${rel.sourceFieldId}-${rel.targetFieldId}-${
                    rel.createdAt || 0
                }`;
            })
            .join('|');

        return `${tablesVersion}::${relationshipsVersion}`;
    }, [currentDiagram]);

    // Generate initial DBML from the diagram
    const generateDBML = useMemo(() => {
        const filteredDiagram: Diagram = {
            ...currentDiagram,
            tables: filteredTables,
            relationships:
                currentDiagram.relationships?.filter((rel) => {
                    const sourceTable = filteredTables.find(
                        (t) => t.id === rel.sourceTableId
                    );
                    const targetTable = filteredTables.find(
                        (t) => t.id === rel.targetTableId
                    );

                    return sourceTable && targetTable;
                }) ?? [],
        } satisfies Diagram;

        const filteredDiagramWithoutSpaces: Diagram = {
            ...filteredDiagram,
            tables:
                filteredDiagram.tables?.map((table) => ({
                    ...table,
                    name: table.name.replace(/\s/g, '_'),
                    fields: table.fields.map((field) => ({
                        ...field,
                        name: field.name.replace(/\s/g, '_'),
                    })),
                    indexes: table.indexes?.map((index) => ({
                        ...index,
                        name: index.name.replace(/\s/g, '_'),
                    })),
                })) ?? [],
        } satisfies Diagram;

        const baseScript = exportBaseSQL(filteredDiagramWithoutSpaces, true);

        try {
            const importFormat = databaseTypeToImportFormat(
                currentDiagram.databaseType
            );

            return importer.import(baseScript, importFormat);
        } catch (e) {
            console.error(e);

            toast({
                title: 'Error',
                description:
                    'Failed to generate DBML. We would appreciate if you could report this issue!',
                variant: 'destructive',
            });

            return '';
        }
    }, [currentDiagram, filteredTables, toast]);

    // Load content from localStorage or generate new DBML on first render
    useEffect(() => {
        // Set initial diagram version
        setDiagramVersion(currentDiagramVersion);
        lastProcessedDiagramRef.current = currentDiagramVersion;

        console.log(
            'DBML DEBUG: Initializing editor with current diagram state'
        );

        const savedContent = localStorage.getItem(dbmlStorageKey);

        if (savedContent) {
            // We have saved content, but we need to check if it's still valid
            console.log('DBML DEBUG: Found saved DBML content');

            // For now, we'll use it, but we could enhance this to store
            // diagram version hash alongside the content for validation
            setDbmlContent(savedContent);
            setIsDirty(true);

            // Show notification about recovered content
            toast({
                title: 'Recovered DBML Edits',
                description:
                    'Your previous unsaved DBML edits have been restored.',
                variant: 'default',
            });
        } else {
            console.log('DBML DEBUG: No saved content, generating fresh DBML');
            const newContent = generateDBML;
            setDbmlContent(newContent);
            setOriginalDbmlContent(newContent); // Store original content
        }
    }, [generateDBML, dbmlStorageKey, toast, currentDiagramVersion]);

    // Update the editor content when the diagram changes, but only if not dirty
    useEffect(() => {
        if (!isDirty) {
            const newContent = generateDBML;
            setDbmlContent(newContent);
            setOriginalDbmlContent(newContent); // Update original content
            // Clear any saved content when we regenerate
            localStorage.removeItem(dbmlStorageKey);
        }
    }, [generateDBML, isDirty, dbmlStorageKey]);

    // Auto-save to localStorage when content changes
    useEffect(() => {
        if (isDirty && dbmlContent) {
            localStorage.setItem(dbmlStorageKey, dbmlContent);
        }
    }, [dbmlContent, isDirty, dbmlStorageKey]);

    // Clean up localStorage when changes are applied or discarded
    useEffect(() => {
        if (!isDirty) {
            localStorage.removeItem(dbmlStorageKey);
        }
    }, [isDirty, dbmlStorageKey]);

    // Handle component unmount - no need to clean up as we want to keep unsaved changes
    useEffect(() => {
        return () => {
            // Only keep in localStorage if there are unsaved changes
            if (!isDirty) {
                localStorage.removeItem(dbmlStorageKey);
            }
        };
    }, [isDirty, dbmlStorageKey]);

    // Handle external diagram changes
    useEffect(() => {
        // Skip on first render since we handle it in initialization
        if (!diagramVersion || diagramVersion === currentDiagramVersion) {
            return;
        }

        // If the diagram has changed, update even if dirty
        console.log('DBML DEBUG: External diagram changes detected');

        // If there are unsaved changes, notify the user
        if (isDirty) {
            console.log(
                'DBML DEBUG: Unsaved changes discarded due to external diagram changes'
            );
            toast({
                title: 'Diagram Updated',
                description:
                    'External changes to the diagram have been detected. Your unsaved DBML edits have been discarded.',
                variant: 'default',
            });
        }

        // Switch back to read-only mode if in edit mode
        if (toggleEditMode) {
            console.log(
                'DBML DEBUG: Switching back to read-only mode due to external changes'
            );
            toggleEditMode();

            // Show an additional notification about the mode switch
            toast({
                title: 'Edit Mode Disabled',
                description:
                    'Due to external diagram changes, the DBML editor has been switched to read-only mode.',
                variant: 'default',
            });
        }

        // Reset editor with updated content
        setDbmlContent(generateDBML);
        setOriginalDbmlContent(generateDBML);
        setIsDirty(false);
        setDbmlError(null);

        // Update editor content if editor is mounted
        if (editorRef.current) {
            editorRef.current.setValue(generateDBML);
        }

        // Clear any saved content
        localStorage.removeItem(dbmlStorageKey);

        // Update version tracker
        setDiagramVersion(currentDiagramVersion);
        lastProcessedDiagramRef.current = currentDiagramVersion;
    }, [
        currentDiagramVersion,
        diagramVersion,
        generateDBML,
        isDirty,
        toast,
        dbmlStorageKey,
        toggleEditMode,
    ]);

    // Validate DBML syntax as the user types
    const validateDBML = useCallback((content: string | undefined) => {
        const debouncedValidation = debounce(
            (contentToValidate: string | undefined) => {
                if (!contentToValidate || !contentToValidate.trim()) {
                    setDbmlError(null);
                    return;
                }

                try {
                    const parser = new Parser();
                    parser.parse(contentToValidate, 'dbml');
                    setDbmlError(null);
                } catch (e) {
                    const error = parseDBMLError(e);
                    setDbmlError(error);
                }
            },
            500
        );

        debouncedValidation(content);
    }, []);

    // Handle editor content changes
    const handleDBMLChange = useCallback(
        (value: string | undefined) => {
            if (value !== undefined) {
                const contentChanged = value !== dbmlContent;
                console.log(`DBML DEBUG: Content changed: ${contentChanged}`);

                if (contentChanged) {
                    setDbmlContent(value);
                    setIsDirty(true);
                    console.log('DBML DEBUG: Setting isDirty to true');
                    validateDBML(value);
                }
            }
        },
        [validateDBML, dbmlContent]
    );

    // Apply the DBML changes to the diagram
    const applyDBMLChanges = useCallback(async () => {
        if (dbmlError) {
            toast({
                title: 'DBML Error',
                description: `Please fix the error before applying changes: ${dbmlError.message} at line ${dbmlError.line}, column ${dbmlError.column}`,
                variant: 'destructive',
            });
            return;
        }

        try {
            // Import the DBML content to create a new diagram
            const importedDiagram = await importDBMLToDiagram(dbmlContent);

            // Create table name to ID mapping for the current diagram
            const currentTableMap = new Map<string, DBTable>();
            currentDiagram.tables?.forEach((table) => {
                const key = `${table.schema || ''}.${table.name}`;
                currentTableMap.set(key, table);
            });

            // Create a field name to ID mapping for current tables
            const currentFieldMap = new Map<string, Map<string, string>>();
            currentDiagram.tables?.forEach((table) => {
                const fieldMap = new Map<string, string>();
                table.fields.forEach((field) => {
                    fieldMap.set(field.name, field.id);
                });
                currentFieldMap.set(table.id, fieldMap);
            });

            // Create imported table ID to field name mapping
            const importedFieldNameMap = new Map<string, Map<string, string>>();
            importedDiagram.tables?.forEach((table) => {
                const fieldMap = new Map<string, string>();
                table.fields.forEach((field) => {
                    fieldMap.set(field.id, field.name);
                });
                importedFieldNameMap.set(table.id, fieldMap);
            });

            // Prepare tables to add/update with preserved positions
            const tablesToAdd: DBTable[] = [];
            const tablesToUpdate: DBTable[] = [];

            // Process imported tables
            importedDiagram.tables?.forEach((importedTable) => {
                const tableKey = `${importedTable.schema || ''}.${importedTable.name}`;
                const existingTable = currentTableMap.get(tableKey);

                if (existingTable) {
                    // Preserve position, color, and ID for existing tables
                    // Create a copy of the imported table first
                    const tableWithPreservedIds = {
                        ...importedTable,
                        id: existingTable.id,
                        x: existingTable.x,
                        y: existingTable.y,
                        color: existingTable.color,
                        // Preserve field IDs for fields that exist in both tables (matching by name)
                        fields: importedTable.fields.map((importedField) => {
                            // Try to find matching field in existing table
                            const existingField = existingTable.fields.find(
                                (f) => f.name === importedField.name
                            );
                            if (existingField) {
                                // Preserve the existing field ID
                                console.log(
                                    `DBML DEBUG: Preserving ID for field ${importedField.name} (${existingField.id})`
                                );
                                return {
                                    ...importedField,
                                    id: existingField.id,
                                };
                            }
                            // Use the new ID for new fields
                            return importedField;
                        }),
                    };

                    tablesToUpdate.push(tableWithPreservedIds);
                    currentTableMap.delete(tableKey); // Remove from map to track remaining tables
                } else {
                    tablesToAdd.push(importedTable);
                }
            });

            // Tables remaining in the map need to be removed
            const tablesToRemove = Array.from(currentTableMap.values());

            // Find relationships to update
            console.log('DBML DEBUG: Starting relationship processing');
            console.log(
                'DBML DEBUG: Current relationships:',
                currentDiagram.relationships?.length || 0
            );
            console.log(
                'DBML DEBUG: Imported relationships:',
                importedDiagram.relationships?.length || 0
            );

            // Create a mapping of relationships in the imported DBML by their source and target tables/fields
            const importedRelationshipMap = new Map<string, boolean>();
            importedDiagram.relationships?.forEach((rel) => {
                const importedSourceTable = importedDiagram.tables?.find(
                    (t) => t.id === rel.sourceTableId
                );
                const importedTargetTable = importedDiagram.tables?.find(
                    (t) => t.id === rel.targetTableId
                );

                if (importedSourceTable && importedTargetTable) {
                    const importedSourceField = importedSourceTable.fields.find(
                        (f) => f.id === rel.sourceFieldId
                    );
                    const importedTargetField = importedTargetTable.fields.find(
                        (f) => f.id === rel.targetFieldId
                    );

                    if (importedSourceField && importedTargetField) {
                        // Create a unique key for this relationship based on table and field names
                        const key = `${importedSourceTable.name}.${importedSourceField.name}:${importedTargetTable.name}.${importedTargetField.name}`;
                        importedRelationshipMap.set(key, true);

                        // Also add the reverse direction as relationships can be defined in either direction
                        const reverseKey = `${importedTargetTable.name}.${importedTargetField.name}:${importedSourceTable.name}.${importedSourceField.name}`;
                        importedRelationshipMap.set(reverseKey, true);
                    }
                }
            });

            console.log(
                `DBML DEBUG: Created map of ${importedRelationshipMap.size} imported relationship signatures`
            );

            const relationshipsToRemove =
                currentDiagram.relationships?.filter((rel) => {
                    // Remove relationships connected to tables that will be removed
                    const isConnectedToRemovedTable = tablesToRemove.some(
                        (table) =>
                            table.id === rel.sourceTableId ||
                            table.id === rel.targetTableId
                    );

                    if (isConnectedToRemovedTable) {
                        console.log(
                            `DBML DEBUG: Relationship ${rel.id} marked for removal - connected to removed table`
                        );
                        return true;
                    }

                    // Check if this relationship exists in the imported DBML
                    const currentSourceTable = currentDiagram.tables?.find(
                        (t) => t.id === rel.sourceTableId
                    );
                    const currentTargetTable = currentDiagram.tables?.find(
                        (t) => t.id === rel.targetTableId
                    );

                    if (currentSourceTable && currentTargetTable) {
                        const currentSourceField =
                            currentSourceTable.fields.find(
                                (f) => f.id === rel.sourceFieldId
                            );
                        const currentTargetField =
                            currentTargetTable.fields.find(
                                (f) => f.id === rel.targetFieldId
                            );

                        if (currentSourceField && currentTargetField) {
                            // Create a key to look up in our map of imported relationships
                            const relKey = `${currentSourceTable.name}.${currentSourceField.name}:${currentTargetTable.name}.${currentTargetField.name}`;
                            const relReverseKey = `${currentTargetTable.name}.${currentTargetField.name}:${currentSourceTable.name}.${currentSourceField.name}`;

                            // If this relationship doesn't exist in the imported DBML, mark it for removal
                            if (
                                !importedRelationshipMap.has(relKey) &&
                                !importedRelationshipMap.has(relReverseKey)
                            ) {
                                console.log(
                                    `DBML DEBUG: Relationship ${rel.id} marked for removal - deleted from DBML`
                                );
                                return true;
                            }
                        }
                    }

                    // Check if the specific fields involved in the relationship have changed in the updated tables
                    const sourceTable = tablesToUpdate.find(
                        (t) => t.id === rel.sourceTableId
                    );
                    const targetTable = tablesToUpdate.find(
                        (t) => t.id === rel.targetTableId
                    );

                    if (sourceTable || targetTable) {
                        // Get the field names from the current tables
                        const sourceTableFields =
                            currentDiagram.tables?.find(
                                (t) => t.id === rel.sourceTableId
                            )?.fields || [];
                        const targetTableFields =
                            currentDiagram.tables?.find(
                                (t) => t.id === rel.targetTableId
                            )?.fields || [];

                        const sourceFieldName = sourceTableFields.find(
                            (f) => f.id === rel.sourceFieldId
                        )?.name;
                        const targetFieldName = targetTableFields.find(
                            (f) => f.id === rel.targetFieldId
                        )?.name;

                        if (!sourceFieldName || !targetFieldName) {
                            console.log(
                                `DBML DEBUG: Relationship ${rel.id} marked for removal - can't find field names`
                            );
                            return true; // Can't find field names, something is wrong, remove relationship
                        }

                        console.log(
                            `DBML DEBUG: Checking relationship ${rel.id} between fields "${sourceFieldName}" and "${targetFieldName}"`
                        );

                        // Check if the fields still exist in the updated tables by name
                        if (sourceTable) {
                            const sourceFieldExists = sourceTable.fields.some(
                                (field) => field.name === sourceFieldName
                            );
                            if (!sourceFieldExists) {
                                console.log(
                                    `DBML DEBUG: Relationship ${rel.id} marked for removal - source field "${sourceFieldName}" no longer exists`
                                );
                                return true; // Source field no longer exists, remove relationship
                            }
                        }

                        if (targetTable) {
                            const targetFieldExists = targetTable.fields.some(
                                (field) => field.name === targetFieldName
                            );
                            if (!targetFieldExists) {
                                console.log(
                                    `DBML DEBUG: Relationship ${rel.id} marked for removal - target field "${targetFieldName}" no longer exists`
                                );
                                return true; // Target field no longer exists, remove relationship
                            }
                        }
                    }

                    return false;
                }) || [];

            console.log(
                `DBML DEBUG: Identified ${relationshipsToRemove.length} relationships to remove due to table/field changes`
            );

            // Transaction: batch operations for better performance

            // 1. Remove tables and relationships first
            if (tablesToRemove.length > 0) {
                await removeTables(tablesToRemove.map((t) => t.id));
                console.log(
                    `DBML DEBUG: Removed ${tablesToRemove.length} tables`
                );
            }

            if (relationshipsToRemove.length > 0) {
                await removeRelationships(
                    relationshipsToRemove.map((r) => r.id)
                );
                console.log(
                    `DBML DEBUG: Removed ${relationshipsToRemove.length} relationships due to table/field changes`
                );
            }

            // 2. Update existing tables
            if (tablesToUpdate.length > 0) {
                await updateTablesState(() => {
                    return tablesToUpdate;
                });
                console.log(
                    `DBML DEBUG: Updated ${tablesToUpdate.length} existing tables`
                );
            }

            // 3. Add new tables
            if (tablesToAdd.length > 0) {
                await addTables(tablesToAdd);
                console.log(
                    `DBML DEBUG: Added ${tablesToAdd.length} new tables`
                );
            }

            // Get the most up-to-date diagram with all tables after operations
            // This is crucial for ensuring we have the correct IDs for newly added tables
            const updatedDiagram = { ...currentDiagram };

            // First, remove tables that were deleted
            updatedDiagram.tables = (updatedDiagram.tables || []).filter(
                (table) => !tablesToRemove.some((t) => t.id === table.id)
            );

            // Then update existing tables
            updatedDiagram.tables = updatedDiagram.tables.map(
                (table) =>
                    tablesToUpdate.find((t) => t.id === table.id) || table
            );

            // Finally add new tables with their final IDs
            // Since we've already added them to the database, use the tables as defined
            updatedDiagram.tables = [...updatedDiagram.tables, ...tablesToAdd];

            console.log(
                `DBML DEBUG: Updated diagram now has ${updatedDiagram.tables.length} tables`
            );

            // 4. For relationships, take a simpler approach: remove all relationships and add new ones
            // This is more reliable for DBML direct editing

            // First, create a map of table names to IDs for the updated diagram
            const allCurrentTables = updatedDiagram.tables || [];

            const tableNameToId = new Map<string, string>();
            allCurrentTables.forEach((table) => {
                tableNameToId.set(table.name, table.id);
            });
            console.log(
                `DBML DEBUG: Mapped ${tableNameToId.size} tables by name for relationship processing`
            );

            // Create a map of field names to IDs for each table
            const tableFieldMap = new Map<string, Map<string, string>>();
            allCurrentTables.forEach((table) => {
                const fieldMap = new Map<string, string>();
                table.fields.forEach((field) => {
                    fieldMap.set(field.name, field.id);
                });
                tableFieldMap.set(table.id, fieldMap);
            });

            // Now map the DBML relationships to actual relationships with correct IDs
            let relationshipsToAdd: DBRelationship[] = [];

            // Handle relationships directly from the imported diagram
            if (
                importedDiagram.relationships &&
                importedDiagram.relationships.length > 0
            ) {
                console.log(
                    'DBML DEBUG: Processing relationships from DBML...'
                );

                // Create a map of table names to IDs for both current and imported diagrams
                const tableNameToCurrentId = new Map();
                const tableNameToImportedId = new Map();

                // Map current tables
                updatedDiagram.tables?.forEach((table) => {
                    tableNameToCurrentId.set(table.name, table.id);
                });

                // Map imported tables
                importedDiagram.tables?.forEach((table) => {
                    tableNameToImportedId.set(table.name, table.id);
                });

                console.log(
                    `DBML DEBUG: Table name mapping - Current: ${tableNameToCurrentId.size}, Imported: ${tableNameToImportedId.size}`
                );

                // Map relationships by table and field names
                relationshipsToAdd = importedDiagram.relationships
                    .map((rel) => {
                        try {
                            // Get source and target tables from imported diagram
                            const importedSourceTable =
                                importedDiagram.tables?.find(
                                    (t) => t.id === rel.sourceTableId
                                );
                            const importedTargetTable =
                                importedDiagram.tables?.find(
                                    (t) => t.id === rel.targetTableId
                                );

                            if (!importedSourceTable || !importedTargetTable) {
                                console.log(
                                    "DBML DEBUG: Couldn't find source or target table in imported diagram"
                                );
                                return null;
                            }

                            // Get source and target fields from imported diagram
                            const importedSourceField =
                                importedSourceTable.fields.find(
                                    (f) => f.id === rel.sourceFieldId
                                );
                            const importedTargetField =
                                importedTargetTable.fields.find(
                                    (f) => f.id === rel.targetFieldId
                                );

                            if (!importedSourceField || !importedTargetField) {
                                console.log(
                                    "DBML DEBUG: Couldn't find source or target field in imported tables"
                                );
                                return null;
                            }

                            console.log(
                                `DBML DEBUG: Processing DBML relationship between ${importedSourceTable.name}.${importedSourceField.name} and ${importedTargetTable.name}.${importedTargetField.name}`
                            );

                            // Find corresponding tables in current diagram by name
                            const currentSourceTableId =
                                tableNameToCurrentId.get(
                                    importedSourceTable.name
                                );
                            const currentTargetTableId =
                                tableNameToCurrentId.get(
                                    importedTargetTable.name
                                );

                            if (
                                !currentSourceTableId ||
                                !currentTargetTableId
                            ) {
                                console.log(
                                    `DBML DEBUG: Couldn't map table names to current IDs: ${importedSourceTable.name}, ${importedTargetTable.name}`
                                );
                                return null;
                            }

                            // Find corresponding fields in current tables by name
                            const currentSourceTable =
                                updatedDiagram.tables?.find(
                                    (t) => t.id === currentSourceTableId
                                );
                            const currentTargetTable =
                                updatedDiagram.tables?.find(
                                    (t) => t.id === currentTargetTableId
                                );

                            if (!currentSourceTable || !currentTargetTable) {
                                console.log(
                                    "DBML DEBUG: Couldn't find current source or target tables"
                                );
                                return null;
                            }

                            const currentSourceField =
                                currentSourceTable.fields.find(
                                    (f) => f.name === importedSourceField.name
                                );
                            const currentTargetField =
                                currentTargetTable.fields.find(
                                    (f) => f.name === importedTargetField.name
                                );

                            if (!currentSourceField || !currentTargetField) {
                                console.log(
                                    `DBML DEBUG: Couldn't find fields in current tables: ${importedSourceField.name}, ${importedTargetField.name}`
                                );
                                console.log(
                                    'DBML DEBUG: Available source fields:',
                                    currentSourceTable.fields.map((f) => f.name)
                                );
                                console.log(
                                    'DBML DEBUG: Available target fields:',
                                    currentTargetTable.fields.map((f) => f.name)
                                );
                                return null;
                            }

                            // Check if this relationship already exists
                            const existingRelationship =
                                currentDiagram.relationships?.find(
                                    (existingRel) =>
                                        (existingRel.sourceTableId ===
                                            currentSourceTableId &&
                                            existingRel.targetTableId ===
                                                currentTargetTableId &&
                                            existingRel.sourceFieldId ===
                                                currentSourceField.id &&
                                            existingRel.targetFieldId ===
                                                currentTargetField.id) ||
                                        // Check the reverse direction too
                                        (existingRel.sourceTableId ===
                                            currentTargetTableId &&
                                            existingRel.targetTableId ===
                                                currentSourceTableId &&
                                            existingRel.sourceFieldId ===
                                                currentTargetField.id &&
                                            existingRel.targetFieldId ===
                                                currentSourceField.id)
                                );

                            if (existingRelationship) {
                                console.log(
                                    `DBML DEBUG: Relationship already exists with ID ${existingRelationship.id}, keeping it`
                                );
                                return null; // Skip adding new relationships for ones that already exist
                            }

                            // Return properly mapped relationship
                            return {
                                id: generateId(), // Generate a new ID for the relationship
                                sourceTableId: currentSourceTableId,
                                targetTableId: currentTargetTableId,
                                sourceFieldId: currentSourceField.id,
                                targetFieldId: currentTargetField.id,
                                // Copy other properties from the imported relationship
                                sourceCardinality: rel.sourceCardinality,
                                targetCardinality: rel.targetCardinality,
                                // Ensure schema properties are properly typed
                                sourceSchema: currentSourceTable.schema || '',
                                targetSchema: currentTargetTable.schema || '',
                                name: `${importedSourceTable.name}_${importedSourceField.name}_${importedTargetTable.name}_${importedTargetField.name}`,
                                createdAt: Date.now(),
                            };
                        } catch (e) {
                            console.error(
                                'DBML DEBUG: Error mapping relationship:',
                                e
                            );
                            return null;
                        }
                    })
                    .filter((rel) => rel !== null) as DBRelationship[];

                console.log(
                    `DBML DEBUG: Created ${relationshipsToAdd.length} relationships from DBML`
                );
            }

            // Add the new relationships
            if (relationshipsToAdd.length > 0) {
                await addRelationships(relationshipsToAdd);
                console.log(
                    `DBML DEBUG: Added ${relationshipsToAdd.length} new relationships`
                );
            }

            setIsDirty(false);

            // After all changes are applied, regenerate the DBML to show the current state
            const updatedDBML = await importer.import(
                exportBaseSQL(
                    {
                        ...currentDiagram,
                        tables: updatedDiagram.tables,
                        // Include all current relationships, both existing and newly added
                        relationships: [
                            ...(currentDiagram.relationships || []).filter(
                                (rel) =>
                                    !relationshipsToRemove.some(
                                        (r) => r.id === rel.id
                                    )
                            ),
                            ...relationshipsToAdd,
                        ],
                    },
                    true
                ),
                databaseTypeToImportFormat(currentDiagram.databaseType)
            );

            // Reset the editor state with the updated content
            setDbmlContent(updatedDBML);
            setOriginalDbmlContent(updatedDBML);
            setIsDirty(false);
            setDbmlError(null);

            // Clear any saved content
            localStorage.removeItem(dbmlStorageKey);

            // Update the diagram version
            setDiagramVersion(currentDiagramVersion);
            lastProcessedDiagramRef.current = currentDiagramVersion;

            // Count tables that were truly modified vs just preserved (same structure)
            const tablesKeptUnchanged = tablesToUpdate.filter(
                (updatedTable) => {
                    const originalTable = currentDiagram.tables?.find(
                        (t) => t.id === updatedTable.id
                    );
                    if (!originalTable) return false;

                    // Check if fields are the same (both count and content)
                    if (
                        originalTable.fields.length !==
                        updatedTable.fields.length
                    )
                        return false;

                    // Check if all fields are the same (by name and type)
                    const allFieldsSame = originalTable.fields.every(
                        (originalField) => {
                            const updatedField = updatedTable.fields.find(
                                (f) => f.id === originalField.id
                            );
                            if (!updatedField) return false;

                            // Check if field properties changed (only compare the meaningful properties)
                            return (
                                originalField.name === updatedField.name &&
                                originalField.type === updatedField.type &&
                                originalField.primaryKey ===
                                    updatedField.primaryKey
                            );
                        }
                    );

                    return allFieldsSame;
                }
            );

            // Truly updated tables are those that were "updated" but had actual changes
            const tablesActuallyChanged =
                tablesToUpdate.length - tablesKeptUnchanged.length;

            // Create a description message based on what actually changed
            let description;
            if (
                tablesToAdd.length === 0 &&
                tablesActuallyChanged === 0 &&
                tablesToRemove.length === 0
            ) {
                description = 'Nothing changed in the diagram.';
            } else {
                // Build parts of the message for each operation
                const parts = [];
                if (tablesToAdd.length > 0) {
                    parts.push(
                        `${tablesToAdd.length} table${tablesToAdd.length === 1 ? '' : 's'} added`
                    );
                }
                if (tablesActuallyChanged > 0) {
                    parts.push(
                        `${tablesActuallyChanged} table${tablesActuallyChanged === 1 ? '' : 's'} updated`
                    );
                }
                if (tablesToRemove.length > 0) {
                    parts.push(
                        `${tablesToRemove.length} table${tablesToRemove.length === 1 ? '' : 's'} removed`
                    );
                }
                if (tablesKeptUnchanged.length > 0) {
                    parts.push(
                        `${tablesKeptUnchanged.length} table${tablesKeptUnchanged.length === 1 ? '' : 's'} unchanged`
                    );
                }

                description = `The diagram has been updated: ${parts.join(', ')}`;
            }

            toast({
                title: 'DBML Applied',
                description,
                variant: 'default',
            });

            // After successful application, switch back to read-only mode
            if (toggleEditMode) {
                setTimeout(() => {
                    // Switch to read-only mode after a small delay to ensure UI is updated
                    console.log(
                        'DBML DEBUG: Switching to read-only mode after successful changes'
                    );
                    toggleEditMode();

                    toast({
                        title: 'Edit Mode Disabled',
                        description:
                            'The DBML editor has been switched to read-only mode after successful changes.',
                        variant: 'default',
                    });
                }, 1000);
            }
        } catch (e) {
            console.error('Error applying DBML changes:', e);
            toast({
                title: 'Error',
                description:
                    'Failed to apply DBML changes. Please check your DBML syntax.',
                variant: 'destructive',
            });
        }
    }, [
        dbmlContent,
        dbmlError,
        currentDiagram,
        addTables,
        removeTables,
        removeRelationships,
        updateTablesState,
        addRelationships,
        toast,
        currentDiagramVersion,
        dbmlStorageKey,
        toggleEditMode,
    ]);

    // Add global hotkey for applying changes
    useHotkeys(
        operatingSystem === 'mac' ? 'meta+enter' : 'ctrl+enter',
        (event) => {
            event.preventDefault();
            console.log(
                'DBML DEBUG: Global hotkey Cmd+Enter / Ctrl+Enter pressed'
            );

            // Check if we can apply changes
            if (isDirty && !dbmlError && applyButtonRef.current) {
                console.log(
                    'DBML DEBUG: Triggering apply changes via global hotkey'
                );
                applyButtonRef.current.click();
            } else if (dbmlError) {
                toast({
                    title: 'DBML Error',
                    description: 'Please fix errors before applying changes',
                    variant: 'destructive',
                });
            } else if (!isDirty) {
                toast({
                    title: 'No Changes',
                    description: 'There are no changes to apply',
                    variant: 'default',
                });
            }
        },
        {
            enableOnFormTags: ['TEXTAREA'],
            preventDefault: true,
        },
        [isDirty, dbmlError, applyButtonRef, toast]
    );

    // Add a hotkey to handle Cmd+E for toggling edit mode within the editor
    useHotkeys(
        operatingSystem === 'mac' ? 'meta+e' : 'ctrl+e',
        (event) => {
            if (toggleEditMode) {
                event.preventDefault();
                event.stopPropagation();
                console.log(
                    'DBML DEBUG: Global hotkey Cmd+E / Ctrl+E pressed in editor'
                );
                toggleEditMode();
            }
        },
        {
            enableOnFormTags: true,
            preventDefault: true,
        },
        [toggleEditMode]
    );

    // Handle editor reference
    const handleEditorDidMount = useCallback(
        (editor: monaco.editor.IStandaloneCodeEditor) => {
            editorRef.current = editor;
            console.log('DBML DEBUG: Editor mounted');

            // This is more reliable than the onChange prop for detecting user edits
            editor.onDidChangeModelContent(() => {
                const currentContent = editor.getValue();
                // Compare with original content to determine if it's changed
                if (currentContent !== originalDbmlContent) {
                    console.log('DBML DEBUG: Content changed from original');
                    setIsDirty(true);
                }
            });

            // Add command to handle Cmd+E / Ctrl+E to toggle edit mode
            editor.addCommand(
                // Monaco key codes for Cmd+E or Ctrl+E
                monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyE,
                () => {
                    console.log('DBML DEBUG: Editor Cmd+E / Ctrl+E pressed');
                    if (toggleEditMode) {
                        toggleEditMode();
                    }
                }
            );

            // Editor-specific key binding for Cmd+Enter (keeping this as a backup)
            editor.addCommand(
                // Monaco key codes for Cmd+Enter or Ctrl+Enter
                monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,
                () => {
                    console.log(
                        `DBML DEBUG: Editor Cmd+Enter pressed, isDirty=${isDirty}, hasError=${!!dbmlError}`
                    );

                    // Simply click the Apply Changes button if it's available and not disabled
                    if (isDirty && !dbmlError && applyButtonRef.current) {
                        console.log(
                            'DBML DEBUG: Clicking Apply Changes button via editor shortcut'
                        );
                        applyButtonRef.current.click();
                    } else if (dbmlError) {
                        toast({
                            title: 'DBML Error',
                            description:
                                'Please fix errors before applying changes',
                            variant: 'destructive',
                        });
                    } else if (!isDirty) {
                        toast({
                            title: 'No Changes',
                            description: 'There are no changes to apply',
                            variant: 'default',
                        });
                    }
                }
            );
        },
        [isDirty, dbmlError, toast, originalDbmlContent, toggleEditMode]
    );

    // Set error markers in editor - add this back
    useEffect(() => {
        if (monacoInstance && editorRef.current) {
            if (dbmlError) {
                monacoInstance.editor.setModelMarkers(
                    editorRef.current.getModel()!,
                    'dbml-validator',
                    [
                        {
                            startLineNumber: dbmlError.line,
                            startColumn: dbmlError.column,
                            endLineNumber: dbmlError.line,
                            endColumn: dbmlError.column + 1,
                            message: dbmlError.message,
                            severity: monaco.MarkerSeverity.Error,
                        },
                    ]
                );
            } else {
                monacoInstance.editor.setModelMarkers(
                    editorRef.current.getModel()!,
                    'dbml-validator',
                    []
                );
            }
        }
    }, [dbmlError, monacoInstance]);

    // Handle discard changes
    const handleDiscardChanges = useCallback(() => {
        setDbmlContent(generateDBML);
        setIsDirty(false);
        setDbmlError(null);
        localStorage.removeItem(dbmlStorageKey);
    }, [generateDBML, dbmlStorageKey]);

    return (
        <div className="flex h-full flex-col">
            <div className="mb-2 rounded bg-blue-100 p-2 text-sm text-blue-700 dark:bg-blue-900/20 dark:text-blue-300">
                <strong>Interactive DBML Editor (beta)</strong>: Edit your
                diagram directly using DBML syntax. Changes won't be applied
                until you click "Apply Changes" or press <kbd>Cmd+Enter</kbd> (
                <kbd>Ctrl+Enter</kbd> on Windows).
            </div>

            {dbmlError && (
                <div className="mb-2 rounded bg-red-100 p-2 text-sm text-red-500 dark:bg-red-900/20">
                    Error at line {dbmlError.line}, column {dbmlError.column}:{' '}
                    {dbmlError.message}
                </div>
            )}

            <CodeSnippet
                code={dbmlContent}
                className="my-0.5 flex-1"
                editorProps={{
                    height: '100%',
                    defaultLanguage: 'dbml',
                    beforeMount: setupDBMLLanguage,
                    loading: false,
                    theme: getEditorTheme(effectiveTheme),
                    onChange: handleDBMLChange,
                    onMount: handleEditorDidMount,
                    options: {
                        wordWrap: 'off',
                        mouseWheelZoom: false,
                        domReadOnly: false, // Allow editing
                        readOnly: false, // Allow editing
                    },
                }}
            />

            {isDirty && (
                <div className="mt-2 flex justify-end gap-2">
                    <Button variant="outline" onClick={handleDiscardChanges}>
                        Discard Changes
                    </Button>
                    <Button
                        ref={applyButtonRef}
                        variant="default"
                        onClick={applyDBMLChanges}
                        disabled={!!dbmlError}
                        title="Apply changes (⌘+Enter / Ctrl+Enter)"
                        aria-label="Apply changes, can also use Command+Enter or Control+Enter"
                    >
                        Apply Changes
                    </Button>
                </div>
            )}
        </div>
    );
};
