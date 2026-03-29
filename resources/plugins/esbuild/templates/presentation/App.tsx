import {
  Deck, Slide, Heading, Text, FlexBox, Box, Grid,
  UnorderedList, ListItem,
  Appear, CodePane, Notes,
  DefaultTemplate, fadeTransition
} from 'spectacle'

const theme = {
  colors: {
    primary: '#1e293b',
    secondary: '#6366f1',
    tertiary: '#f8fafc',
  },
  fonts: {
    header: '"Inter", "SF Pro Display", -apple-system, sans-serif',
    text: '"Inter", "SF Pro Text", -apple-system, sans-serif',
  },
}

export default function App() {
  return (
    <Deck theme={theme} template={<DefaultTemplate />}>
      {/* Slide 1: Title */}
      <Slide>
        <FlexBox height="100%" flexDirection="column" justifyContent="center" alignItems="center">
          <Heading fontSize="h1" margin="0px">Your Presentation Title</Heading>
          <Text fontSize="h3" color="secondary" margin="8px 0 0 0">
            A subtitle or tagline goes here
          </Text>
        </FlexBox>
        <Notes>Speaker notes go here. Press "s" to open presenter mode.</Notes>
      </Slide>

      {/* Slide 2: Bullet list with Appear animation */}
      <Slide transition={fadeTransition}>
        <Heading fontSize="h2" margin="0 0 24px 0">Key Points</Heading>
        <UnorderedList>
          <Appear><ListItem>First important point with details</ListItem></Appear>
          <Appear><ListItem>Second important point with details</ListItem></Appear>
          <Appear><ListItem>Third important point with details</ListItem></Appear>
        </UnorderedList>
      </Slide>

      {/* Slide 3: Two-column layout */}
      <Slide>
        <Heading fontSize="h2" margin="0 0 24px 0">Comparison</Heading>
        <Grid gridTemplateColumns="1fr 1fr" gridGap={24}>
          <Box backgroundColor="#f1f5f9" padding="24px" style={{ borderRadius: '12px' }}>
            <Heading fontSize={28} margin="0 0 12px 0" color="secondary">Option A</Heading>
            <Text fontSize={20} margin="0px">Description of the first option.</Text>
          </Box>
          <Box backgroundColor="#f1f5f9" padding="24px" style={{ borderRadius: '12px' }}>
            <Heading fontSize={28} margin="0 0 12px 0" color="secondary">Option B</Heading>
            <Text fontSize={20} margin="0px">Description of the second option.</Text>
          </Box>
        </Grid>
      </Slide>

      {/* Slide 4: Code example */}
      <Slide>
        <Heading fontSize="h2" margin="0 0 24px 0">Code Example</Heading>
        <CodePane language="typescript">{`
const greeting = (name: string) => {
  return \`Hello, \${name}!\`
}

console.log(greeting('World'))
        `}</CodePane>
      </Slide>

      {/* Slide 5: Closing */}
      <Slide backgroundColor="#6366f1">
        <FlexBox height="100%" flexDirection="column" justifyContent="center" alignItems="center">
          <Heading fontSize="h1" color="tertiary" margin="0px">Thank You</Heading>
          <Text fontSize="h3" color="tertiary" margin="12px 0 0 0">Questions?</Text>
        </FlexBox>
      </Slide>
    </Deck>
  )
}
