# Architecture

An overview of the architecture for various components within the Toolkit.

## Webviews (Vue framework)

The current implementation uses Vue 3 with Single File Components (SFCs) for modularity. Each webview
is bundled into a single file and packaged into the toolkit at release time. Vue applications may be composed
of individual components in a parent/child heiracrchy. Each component is able to act independently within an
application, however, they must respect the following principles:

1. State can only be stored in a child component if it is not being used for two-way communication (via events)
2. If there is two-way communication, store state in the parent
3. Data should flow down, actions should flow up

Be very mindful about state managment; violating these principles will lead to buggy and hard-to-debug software.

### Bundling

Each webview is bundled into a single file to speed up load times as well as isolate the 'web' modules from the 'node' modules. Webview bundles are automatically generated on compilation by targeting `entry.ts` files when located under a `vue` directory. All bundles are placed directly under `dist`.

Generated bundle names map based off their path relative to `src`: `src/foo/vue/bar/entry.ts` -> `fooBarVue.js`

Running the extension in development mode (e.g. via the `Extension` launch task) starts a local server to automatically rebuild and serve webviews in real-time via hot-module reloading. It's assumed that the server runs on port `8080`, so make sure that nothing is already using that port. Otherwise webviews will not be displayed during development.

### Client/Server

The VS Code API restricts our Webviews to a single `postMessage` function. To simplify developing Webviews, we use a client/server architecture to handle message passing between the view and the extension. This does not mean that clients are restricted to 1 message = 1 response, rather, the frontend ("client") needs to send the first message.

Webview (frontend) clients can be created via `WebviewClientFactory`. This generates a simple Proxy to send messages to the extension, mapping the function name to the command name. Unique IDs are also generated to stop requests from receiving extraneous responses. It is **highly** recommended to use the [Volar](https://marketplace.visualstudio.com/items?itemName=johnsoncodehk.volar) extension for syntax highlighting and type-checking when working with SFCs. Keep in mind that this is purely a development tool: users of the toolkits do not require Volar to view webviews.

Commands and events are defined on the backend via `compileVueWebview` or `compileVueWebviewView` for the special 'view' case. This takes a configuration object that contains information about the webview, such as the name of the main script, the panel id, and the commands/events that the backend provides. This returns a class that can be instantiated into the webview. Webviews can then be executed by calling `start` with any initial data (if applicable). Webviews can be cleared of their internal state without reloading the HTML by calling `clear` with any re-initialization data (if applicable).

### Examples

-   Creating and executing a webview:

    ```ts
    const VueWebview = compileVueWebview({
        id: 'my.view',
        title: 'A title',
        webviewJs: 'myView.js',
        start: (param?: string) => param ?? 'foo',
        events: {
            onBar: new vscode.EventEmitter<number>(),
        },
        commands: {
            foo: () => 'hello!',
            bar() {
                // All commands have access to `WebviewServer` via `this`
                this.emiters.onBar.fire(0)
            },
        },
    })

    // `context` is `ExtContext` provided on activation
    const view = new VueWebview(context)
    view.start('some data')
    view.emitters.onFoo.fire(1)

    // Export a class so the frontend code can use it for types
    export class MyView extends VueWebview {}
    ```

-   Creating the client on the frontend:

    ```ts
    import { MyView } from './backend.ts'
    const client = WebviewClientFactory.create<MyView>()
    ```

-   A basic request/response with error handling:

    ```ts
    client
        .foo()
        .then(response => console.log(response))
        .catch(err => console.log(err))
    ```

    The backend protocol is allowed to throw errors. These result in rejected Promises on the frontend.

-   Registering for events:

    ```ts
    client.onBar(num => console.log(num))
    ```

-   Retrieving initialization data by calling the `init` method:

    ```ts
    client.init(data => console.log(data))
    ```

    Note that data is retrieved only **once**. Subsequent calls made by the same webview resolve `undefined` unless the state is cleared either by `clear` or refreshing the view.

-   Submitting a result (this destroys the view on success):

    ```ts
    client.submit(result).catch(err => console.error('Something went wrong!'))
    ```

    `submit` does nothing on views registered as a `WebviewView` as they cannot be disposed of by the extension.

### Testing

Currently only manual testing is done. Future work will include setting up some basic unit testing capacity via `JSDOM` and `Vue Testing Library`. Strict type-checking may also be enforced on SFCs; currently the type-checking only exists locally due to gaps in the type definitions for the DOM provided by Vue/TypeScript.

## Prompters

A 'prompter' can be thought of as any UI element that displays ('prompts') the user to make some choice or selection, returning their response. This interface is captured with the abstract base class `Prompter` which also contains some extra logic for convenience. Instances of the class can be used alone by calling the async method `prompt`, or by feeding them into a `Wizard`.

```ts
const prompter = createInputBox()
const response = await prompter.prompt()

// Verify that the user did not cancel the prompt
if (isValidResponse(response)) {
    // `response` is now typed as `string`
}
```

### Quick Picks

Pickers can be constructed by using the `createQuickPick` factory function. This currently takes two parameters: a collection of 'items' (required), and an object defining additional options. The items can be an array, a Promise for an array, or an `AsyncIterable`. All collections should resolve to the `DataQuickPickItem` interface. Extra configuration options are derived from valid properties on VS Code's `QuickPick` interface, e.g. `title` sets the title of the resulting picker. Some extra options are also present that change or enhance the default behavior of the picker. For example, using `filterBoxInputSettings` causes the picker to create a new quick pick item based off the user's input.

#### Items

A picker item is simply an extension of VS Code's `QuickPickItem` interface, encapsulating the data it represents in the aptly named `data` field:

```ts
// This can be typed as `DataQuickPickItem<string>`
const item = {
    label: 'An item'
    data: 'some data'
}
```

If the user selects this item, then 'some data' should be returned. Note that the type of data (and therefore type of `Prompter`) can largely be inferred; explicit typing, if done at all, should be limited to item definitions:

```ts
// Results in `QuickPickPrompter<string>`
const prompter = createQuickPick([item])

// Results in `QuickPickPrompter<number>`
const prompter = createQuickPick([{ label: 'Another item', data: 0 }])
```

Often we deal with items derived asychronously (usually by API calls). `createQuickPick` can handle this scenario, showing a loading bar while items load in. For example, consider a scenario where we want to show the user a list of CloudWatch log groups to select. In this case the API is _paginated_, so we should use the `pageableToCollection` utility method to make it easier to map:

```ts
interface LogGroup extends CloudWatchLogs.LogGroup {
    logGroupName: string
    storedBytes: number
}
function isValidLogGroup(obj?: CloudWatchLogs.LogGroup): obj is LogGroup {
    return !!obj && typeof obj.logGroupName === 'string' && typeof obj.storedBytes === 'number'
}

const requester = (request: CloudWatchLogs.DescribeLogGroupsRequest) =>
    client.invokeDescribeLogGroups(request, sdkClient)
const collection = pageableToCollection(requester, request, 'nextToken', 'logGroups')

const groupToItem = (group: LogGroup) => ({ label: group.logGroupName, data: group })
const items = collection.flatten().filter(isValidLogGroup).map(groupToItem)
const prompter = createQuickPick(items) // Results in `QuickPickPrompter<LogGroup>`
```

If we did not care about pagination, we could call the `promise` method on `collection`, causing all items to load in at once:

```ts
const items = collection.flatten().filter(isValidLogGroup).map(groupToItem).promise()
const prompter = createQuickPick(items) // Results in `QuickPickPrompter<LogGroup>`
```

### Input Box

A new input box prompter can be created using the `createInputBox` factory function. Like `createQuickPick`, the input is derived from the properties of VS Code's `InputBox` interface.

### Testing

Quick pick prompters can be tested using `createQuickPickTester`, returning an interface that executes actions on the picker. This currently acts on the real VS Code API, meaning the actions happen asynchronously. Very basic example:

```ts
const items = [
    { label: '1', data: 1 },
    { label: '2', data: 2 },
]
const tester = createQuickPickTester(createQuickPick(items))

tester.assertItems(['1', '2']) // Assert that the prompt displays exactly two items with labels '1' and '2'.
tester.acceptItem('1') // Accept an item with label '1'. This will fail if no item is found.
await tester.result(items[0].data) // Execute the actions, asserting the final result is equivalent to the first item's data
```

## Wizards

Abstractly, a 'wizard' is a collection of discrete, linear steps (subroutines), where each step can potentially be dependent on prior steps, that results in some final state. Wizards are extremely common in top-level flows such as creating a new resource, deployments, or confirmation messages. For these kinds of flows, we have a shared `Wizard` class that handles the bulk of control flow and state management logic for us.

### Creating a Wizard (Quick Picks)

A new wizard can be created by extending off the base `Wizard` class, using the template type to specify the shape of the wizard state. All wizards have an internal 'form' property that is used to assign steps. We can assign UI elements (namely, quick picks) using the `bindPrompter` method on form elements. This method accepts a callback that should return a `Prompter` given the current state. For this example, we will use `createQuickPick` and `createInputBox` for our prompters:

```ts
interface ExampleState {
    foo: string
    bar?: number
}

class ExampleWizard extends Wizard<ExampleState> {
    public constructor() {
        super()

        // Note that steps should only be assigned in the constructor by convention
        // This first step will always be shown as we did not specify any dependencies
        this.form.foo.bindPrompter(() => createInputBox({ title: 'Enter a string' }))

        // Our second step is only shown if the length of `foo` is greater than 5
        // Because of this, we typed `bar` as potentially being `undefined` in `ExampleState`
        const items = [
            { label: '1', data: 1 },
            { label: '2', data: 2 },
        ]
        this.form.bar.bindPrompter(state => createQuickPick(items, { title: `Select a number (${state.foo})` }), {
            showWhen: state => state.foo?.length > 5,
        })
    }
}
```

### Executing

Wizards can be ran by calling the async `run` method:

```ts
const wizard = new ExampleWizard()
const result = await wizard.run()
```

Note that all wizards can potentially return `undefined` if the workflow was cancelled.

### Testing

Use `createWizardTester` on an instance of a wizard. Tests can then be constructed by asserting both the user-defined and internal state. Using the above `ExampleWizard`:

```ts
const tester = createWizardTester(new ExampleWizard())
tester.foo.assertShowFirst() // Fails if `foo` is not shown (or not shown first)
tester.bar.assertDoesNotShow() // True since `foo` is not assigned an explicit value
tester.foo.applyInput('Hello, world!') // Manipulate 'user' state
tester.bar.assertShow() // True since 'foo' has a defined value
```
